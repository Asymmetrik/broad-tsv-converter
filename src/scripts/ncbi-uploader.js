const config = require('../config');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

const logger = require('../services/logger')('a', 'uploader');
const ftpService = require('../services/ftp-service');

const reportProcessor = require('./report-processor');

const { Readable } = require('stream');
const { report } = require('process');

// FTP variables
let ftpClient, isPolling;

// Variables
let submissionParams;
let data;

poll = async (initial = false) => {
    if (submissionParams.pollingEnd === 'disabled') {
        return;
    }

    if (initial) {
        isPolling = true;
        logger.log(`Starting polling, waiting ${config.ftpConfig.pollingInterval} ms to check submission status`)
    }

    // Switched from Interval to Timeout:
    // Interval was running into async issues where the second check was kicked off
    // before the first one had completed.
    polling = setTimeout(getReports, config.ftpConfig.pollingInterval);
}

getReports = async () => {
    submissionParams.skipFtp
        ? getFakeReports()
        : getRealReports();
}

getFakeReports = () => {
    logger.log('Grabbing fake report for testing purposes');
    let reportPath = path.resolve(__dirname, `../../reports/${submissionParams.outputFilename}-report.xml`);
    processReport(reportPath);
}

getRealReports = async () => {
    try {
        let hasSubmissionFile = await ftpClient.exists(`${submissionParams.uploadFolder}/submit.ready`);

        if (hasSubmissionFile) {
            // Exit this entire method, wait to poll again.
            logger.log('Submission status: queued');
            return poll();
        }

        let files = await ftpClient.list(submissionParams.uploadFolder, 'report.([0-9]*.)?xml');

        if (files.length === 0) {
            logger.log('Submission status: processing... awaiting first report');
            return poll();
        }

        // Only way to access this point of the code is if the submit.ready file is not present.
        let reportName = files.length - 1 > 0
            ? `report.${files.length - 1}.xml`
            : 'report.xml';

        let shouldPoll = submissionParams.poll === 'all' || highestReportNumber < submissionParams.poll;
        await downloadReport(reportName, shouldPoll);
    } catch (error) {
        console.log(chalk.red(error.stack))
    }
}

downloadReport = async (reportName, shouldPoll = false) => {
    let remotePath = `${submissionParams.uploadFolder}/${reportName}`;
    let localPath = path.resolve(__dirname, `../../reports/${submissionParams.outputFilename}-${reportName}`);
    await ftpClient.fastGet(remotePath, localPath);
    await processReport(localPath, shouldPoll);
}

processReport =  async (reportPath, shouldPoll = false) => {
    let reportDetails = await reportProcessor.processReport(reportPath);

    if (reportDetails.failed) {
        return stopPolling();
    }
    else if (reportDetails.status === 'processed-ok') {
        reportProcessor.writeAttributesTsv(report, submissionParams);
        return stopPolling();
    }
    else if (reportDetails.isProcessing && shouldPoll) {
        fs.unlinkSync(reportPath);
        poll();
    }
    else {
        stopPolling();
    }
}

stopPolling = () => {
    if (isPolling) {
        isPolling  = false;

        logger.log('Halting polling, and closing FTP client...');

        if (!submissionParams.skipFtp && ftpClient) {
            ftpClient.end();
        }
    }
}

module.exports = {
    processRequest: async (submissionParams_, data_) => {
        submissionParams = submissionParams_;
        data = data_;

        if (submissionParams.reportFilename) {
            await module.exports.extractTsvFromReport(submissionParams_, data_);
        }
        else if (submissionParams.uploadFolder) {
            await module.exports.uploadFiles(submissionParams_, data_);
        }
    },

    uploadFiles: async (submissionParams_, data_) => {
        submissionParams = submissionParams_;
        data = data_;

        if (!submissionParams.uploadFolder) {
            logger.log('No upload folder defined; skipping upload.');
            return;
        }

        if (submissionParams.skipFtp) {
            poll(true);
        }
        else if (submissionParams.uploaded) {
            ftpClient = await ftpService.startFtpClient(submissionParams);
            poll(true);
        }
        else {
            ftpClient = await ftpService.startFtpClient(submissionParams);
            await ftpClient.mkdir(submissionParams.uploadFolder, true);

            if (submissionParams.inputFilename) {
                let remotePath = `${submissionParams.uploadFolder}/submission.xml`;
                let localPath = submissionParams.outputFilepath;
                await ftpClient.fastPut(localPath, remotePath);
                logger.log(`Uploaded ${submissionParams.uploadFolder}/submission.xml`);
            }

            if (submissionParams.uploadFiles) {
                for (filename of submissionParams.uploadFiles) {
                    let localPath = path.resolve(__dirname, `../../files/${filename}`);
                    let remotePath = `${submissionParams.uploadFolder}/${filename}`;

                    await ftpClient.fastPut(localPath, remotePath)
                    logger.log(`Uploaded ${submissionParams.uploadFolder}/${filename}`);
                };
            }

            let localFile = Readable.from(['']);
            let remotePath = `${submissionParams.uploadFolder}/submit.ready`;
            await ftpClient.put(localFile, remotePath);
            logger.log(`Uploaded ${submissionParams.uploadFolder}/submit.ready`);

            poll(true);
        }
    },

    extractTsvFromReport: async (submissionParams_, data_) => {
        submissionParams = submissionParams_;
        data = data_;

        if (!submissionParams.reportFilename) {
            logger.log('No report declared; skipping extract tsv from report');
            return;
        }

        if (submissionParams.uploadFolder) {
            ftpClient = await ftpService.startFtpClient(submissionParams);
            try {
                await downloadReport(submissionParams.reportFilename, 'disabled');
            } catch (error) {
                logger.log(`There was an error downloading the report: ${error.message}`);
                logger.log('Please check your inputs and try again');
                process.exit(1);
            }
        }
        else {
            let reportPath = path.resolve(__dirname, `../../reports/${submissionParams.reportFilename}`);
            processReport(reportPath);
        }
    }
};