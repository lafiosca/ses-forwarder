#!/bin/bash

# "set -e" makes it so if any step fails, the script aborts:
set -e

# Change to the directory of the script
cd "${BASH_SOURCE%/*}"

# Include config variables
source ./config.sh

if [[ $S3PathBackup ]]
then
	aws s3 cp src/process-email/config.js ${S3PathBackup}/config.$(date -Iseconds).js
fi

# Build Lambda package
cd src/process-email
npm install
cd ../..

# Package SAM template (loads Lambda dist zips to S3 locations)
aws cloudformation package \
	--template-file sam-template.json \
	--output-template-file sam-output.yml \
	--s3-bucket "${S3BucketArtifacts}" \
	--s3-prefix "${S3PrefixArtifacts}"

# Deploy CloudFormation stack
aws cloudformation deploy \
	--template-file sam-output.yml \
	--stack-name "${StackName}" \
	--capabilities CAPABILITY_IAM \
	--parameter-overrides \
	S3BucketEmail="${S3BucketEmail}" \
	S3PrefixEmail="${S3PrefixEmail}"

