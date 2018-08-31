'use strict';

const _ = require('lodash');
const { lambda } = require('nice-lambda');
const AWS = require('aws-sdk');
const config = require('./config');

const s3 = new AWS.S3();
const ses = new AWS.SES();

const emailBucket = process.env.S3BucketEmail;
const emailPrefix = process.env.S3PrefixEmail;

const parseRecord = (event) => {
	console.log('Parsing SES record');
	const record = _.get(event, 'Records[0]');

	if (!record) {
		throw new Error('No record found');
	}

	if (event.Records.length !== 1) {
		throw new Error(`Records array length is ${event.Records.length} (not 1)`);
	}

	if (_.get(record, 'eventSource') !== 'aws:ses') {
		throw new Error(`Record's eventSource is '${record.eventSource}' (not 'aws:ses')`);
	}

	if (_.get(record, 'eventVersion') !== '1.0') {
		throw new Error(`Record's eventVersion is '${record.eventVersion}' (not '1.0')`);
	}

	console.log('Record:', JSON.stringify(record, null, 2));

	const mail = _.get(record, 'ses.mail');

	if (!mail) {
		throw new Error('Record did not contain mail');
	}

	const recipients = _.get(record, 'ses.receipt.recipients');

	if (!recipients) {
		throw new Error('Record did not contain recipients');
	}

	/* record.ses.receipt also contains these potentially useful fields:
		"spamVerdict": {
			"status": "FAIL"
		},
		"virusVerdict": {
			"status": "PASS"
		},
		"spfVerdict": {
			"status": "PROCESSING_FAILED"
		},
		"dkimVerdict": {
			"status": "GRAY"
		},
		"dmarcVerdict": {
			"status": "PROCESSING_FAILED"
		},
	*/

	return [mail, recipients];
};

const processAliases = (origRecipients) => {
	console.log(`Processing aliases for original recipients: ${JSON.stringify(origRecipients, null, 2)}`);
	let origRecipient = null;
	let recipients = origRecipients.map((recipient) => {
		for (let i = 0; i < config.aliases.length; i += 1) {
			const alias = config.aliases[i];
			const { pattern, rejectPattern } = alias;
			if (recipient.match(pattern)) {
				if (rejectPattern && recipient.match(rejectPattern)) {
					return null;
				}
				origRecipient = origRecipient || recipient;
				return alias.recipients;
			}
		}
		return null;
	});
	recipients = _.uniq(_.flatten(recipients.filter(x => x)));
	return [recipients, origRecipient];
};

const fetchMessage = mail => s3.getObject({
	Bucket: emailBucket,
	Key: `${emailPrefix}${mail.messageId}`,
})
	.promise()
	.then(result => result.Body.toString())
	.catch((error) => {
		console.error(`Failed to get mail content from S3: ${error}`);
		return null;
	});

const processMessage = (origMessage, origRecipient) => {
	console.log(`Original message:\n${origMessage}`);

	let match = origMessage.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m);

	let header = _.get(match, '[1]', origMessage);
	const body = _.get(match, '[2]', '');

	// Add "Reply-To:" with the "From" address if it doesn't already exist
	match = header.match(/^Reply-To: (.*\r?\n)/im);

	if (match) {
		console.log(`Reply-To address already exists: ${match[1]}`);
	} else {
		console.log('No Reply-To address found');
		match = header.match(/^From: (.*\r?\n)/m);
		if (match) {
			console.log(`Adding Reply-To address: ${match[1]}`);
			header = `${header}Reply-To: ${match[1]}`;
		} else {
			console.error('Reply-To address not added because From address was not found');
		}
	}

	// SES does not allow sending messages from an unverified address,
	// so replace the message's "From:" header with the original
	// recipient (which is a verified domain)
	header = header.replace(
		/^From: (.*)/mg,
		(fromLine, from) => {
			const fromName = from.replace(/"/g, '')
				.replace(/</g, '(')
				.replace(/>/g, ')');
			return `From: "${fromName}" <${origRecipient}>`;
		},
	);

	// Remove the Return-Path header
	header = header.replace(/^Return-Path: (.*)\r?\n/mg, '');

	// Remove Sender header
	header = header.replace(/^Sender: (.*)\r?\n/mg, '');

	// Remove all DKIM-Signature headers to prevent triggering an
	// "InvalidParameterValue: Duplicate header 'DKIM-Signature'" error.
	// These signatures will likely be invalid anyways, since the From
	// header was modified.
	header = header.replace(/^DKIM-Signature: .*\r?\n(\s+.*\r?\n)*/mg, '');

	return `${header}${body}`;
};

const forwardMessage = (recipients, origRecipient, message) => {
	const params = {
		Destinations: recipients,
		Source: origRecipient,
		RawMessage: {
			Data: message,
		},
	};

	console.log(`Sending email via SES ${origRecipient} -> [${recipients.join(', ')}]`);
	console.log(JSON.stringify(params, null, 2));

	return ses.sendRawEmail(params)
		.promise()
		.catch((error) => {
			console.error(error);
			throw new Error('Failed to forward email');
		});
};

exports.handler = lambda(async (event) => {
	console.log('Event:', JSON.stringify(event, null, 2));

	const [mail, origRecipients] = parseRecord(event);
	const [recipients, origRecipient] = processAliases(origRecipients);

	if (_.isEmpty(recipients)) {
		console.log('No recipients after alias processing, let it bounce');
		return { disposition: 'CONTINUE' };
	}

	const origMessage = await fetchMessage(mail);
	const message = processMessage(origMessage, origRecipient);

	await forwardMessage(recipients, origRecipient, message);

	return { disposition: 'STOP_RULE' };
});
