'use strict'

// import core node modules
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import * as url from 'node:url'
import { randomUUID } from 'crypto'

// import third party libraries
import _ from 'lodash'

// import voyzu libraries
import util from '@voyzu/util'
import { HttpRequest, HttpResponse, HTTP_RESPONSE_TYPE, Problem } from '@voyzu/core'
import { AppConfig, } from '@voyzu/entity-helpers'
import { JsonHelper } from '@voyzu/helpers'



const require = createRequire(import.meta.url)

// import installed libraries
// need to "require" aws-sdk due to bug https://github.com/aws/aws-sdk-js-v3/issues/3230
let AWS = require('aws-sdk')

// module level constants
const NUMBER_MESSAGES = 50
const SQS_QUEUE_NAME = 'crm-workflow-sync-domain.fifo'
const SQS_BATCH_SIZE = 15

const LOG_GROUP_NAME = '/voyzu/workflow-executions/sync'
const MESSAGE_GROUP_ID = 'default'



/*
overall sequence:

DOMAINS:
work out the domains based on free or sub or channel or whatever
then send to domain

DOMAIN:
work out users to sync. Then send to user pull

USER PULL:
basically syncs. changes are applied to master.
passes the ball to user compare. 

USER COMPARE:
compares differences, master is the boss here, changes are pushed to contact change, applying to the user only

CONTACT CHANGE
The only non fifo queue here. Or is it?


But on a philosphical level:
a "workflow", and a "workflow execution"
a workflow consists of one or more "steps: the naming convention for a step is {business domain}-workflow-{workflow name}-{step name}
these steps are implemented as an sqs queue which triggers a lambda funciton. The sqs queue and the lambda function are named identially, 
  as per the step naning convention above

advantages over other patterns
- lambda pin-ball lack's visiblity, can't control the flow of events, may not need to know but scalability
- Step Functions, involves additional complexity, and is expensive

workflow execution throughput can be adjusted by:
  - adjusting the batch size, where workflow componentents support processing more than one record
  - adjusting the 'Maximum Concurrency' of the Lambda trigger, this applying mainly to non FIFO queues
  - for FIFO queues setting different "MessageGroupId"'s effectively enables parallel processing, however in this case be sure to set the 
      Maximum Concurrency to avoid over-pulling

managing state
  - logs as DB
  - pass state along
example is if you build in logic not to start a workflow execution if the workflow is already executing. not sure how much latency we are talking about
but surely if you call putLog its there.  Can do text or JSON. 

no brain
  - different to orchestrator pattern  - Each step knows enough to do its work and pass the baton to the next step. Like an octopus

re-use is an interesting one.  some benefit in holding the line on this one, but there is going to be a whole heap of logic in things like enforce integrity.
  This is the classic challenge I've had. provision user is the classic use case.  Real pros and cons here. Back to functions in the lib if re-use is not in view
  although the pipeline may be pretty much the same, there may be some subtle differences e.g. notification of completion. One out of the box idea would be
  sub pipelines

  if you do allow re-use, visibilities of pathways doesn't exist. 

a workflow execution has an 'id' value, this is the value of the request id
a workflow can initiate one or more "jobs", a job has an 'id' value, this is set by the relivant workflow setp, but should begin with the workflow id (?)
in tern jobs can spawn more jobs, known as "sub jobs"
the workflow execution history must be fully described in cloudwatch logs. Each workflow execution will have its own log, this log is in addition to the regular
  component logs created by the `console.log` statement
the workflow should log both workflow execution start and workflow exection end
logging workflow exectuion start is straightforward, however logging workflow execution end is more difficult, as the workflow may have spawed many jobs, which in turn
have spawed many sub-jobs, which themselves may have spawed their sub jobs and so on. The recommended solution is to designate a job as the "last job", which in turn
designates a sub job as the "last job" ans so on. When the final workflow step processes this last job, it must log the workflow execution as complete, and may optionally
send a notification

exception handling
un-happy path is case by case, but should not raise an exception
a step-wide exception handler is not used, rather any exception will trigger an un-handled exception, as per the standard voyzu pattern. These un-handled exceptions
must be triaged and resolved. The exact resolution is case by case and depends on the cause

in terms of tools
its mainly the pattern But maybe some util funtions such as sending sqs to a queue and also maybe logging



*/
// lamdba function entry point.
async function handler(event, context) {
  const packageJson = require('./package.json')

  const body = JsonHelper.parse(event.Records[0].body)
  const requestId = body.RequestId

  // log entry point (component log)
  console.log(`[${packageJson.name}] Event RECEIVED by version ${packageJson.version} in response to request id ${requestId}`)

  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    console.log(JSON.stringify(event))
  } else if (context.mock?.logEvent) {
    console.log(event)
  }

  // initialize the AWS objects we need
  AWS = context.mock?.awsConnection ?? AWS

  const cloudwatchLogs = new AWS.CloudWatchLogs({ apiVersion: '2014-03-28' })
  const sqs = new AWS.SQS()
  const queueUrl = (await sqs.getQueueUrl({ QueueName: SQS_QUEUE_NAME }).promise()).QueueUrl

  // is there already a running execution for this domain
  // var params = {
  //   endTime: 'NUMBER_VALUE',
  //   filterPattern: 'STRING_VALUE',
  //   interleaved: true || false,
  //   limit: 'NUMBER_VALUE',
  //   logGroupIdentifier: 'STRING_VALUE',
  //   logGroupName: 'STRING_VALUE',
  //   logStreamNamePrefix: 'STRING_VALUE',
  //   logStreamNames: [
  //     'STRING_VALUE',
  //     /* more items */
  //   ],
  //   nextToken: 'STRING_VALUE',
  //   startTime: 'NUMBER_VALUE',
  //   unmask: true || false
  // };
  // cloudwatchlogs.filterLogEvents(params, function(err, data) {
  //   if (err) console.log(err, err.stack); // an error occurred
  //   else     console.log(data);           // successful response
  // });

  let logParams = {
    logGroupName: '/voyzu/workflow-executions/sync',
    filterPattern : 'WORKFLOW'
  }

  const logSearchResults = await cloudwatchLogs.filterLogEvents (logParams).promise()

  console.log (logSearchResults)

  return
  // log entry point (workflow execution log)

  // this is workflow step one, create the log group
  let createLogStreamParams = {
    logGroupName: LOG_GROUP_NAME,
    logStreamName: requestId
  }

  try {
    await cloudwatchLogs.createLogStream(createLogStreamParams).promise()
  } catch (error) {
    if (error.code === 'ResourceAlreadyExistsException') {
      console.log(`log group ${createLogStreamParams.logGroupName}/${createLogStreamParams.logStreamName} already exists`)
    } else {
      throw error
    }
  }

  await logEvent(cloudwatchLogs, `WORKFLOW EXECUTION ${requestId} STARTS`, LOG_GROUP_NAME, requestId)

  await logEvent(cloudwatchLogs, `Workflow step ${packageJson.name} begins`, LOG_GROUP_NAME, requestId)

  if (!context.mock) {
    await logEvent(cloudwatchLogs, `Component is logging to https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#logEventViewer:group=${process.env.AWS_LAMBDA_LOG_GROUP_NAME};stream=${process.env.AWS_LAMBDA_LOG_STREAM_NAME}`, LOG_GROUP_NAME, requestId)
  }

  await sendFifoSqsMessages(sqs, ['one', 'two', 'three'], queueUrl)

  await logEvent(cloudwatchLogs, `Workflow step ${packageJson.name} ends`, LOG_GROUP_NAME, requestId)

}


async function sendFifoSqsMessage(sqs, message, sqsQueurUrl, messageGroupId = 'default') {

  const sqsParam = {
    MessageGroupId: messageGroupId,
    MessageDeduplicationId: randomUUID(),
    MessageBody: message,
    QueueUrl: sqsQueurUrl
  }

  await sqs.sendMessage(sqsParam).promise()

}

async function sendFifoSqsMessages(sqs, messages, sqsQueurUrl, messageGroupId = 'default', messageDeduplicationId = randomUUID(), verbose = true) {

  const SQS_BATCH_SIZE = 250
  const WAIT_BETWEEN_BATCHES = 3000

  const sqsParams = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]

    sqsParams.push({
      MessageGroupId: messageGroupId,
      MessageDeduplicationId: messageDeduplicationId,
      MessageBody: message,
      QueueUrl: sqsQueurUrl
    })
  }

  const sqsBatches = _.chunk(sqsParams, SQS_BATCH_SIZE)

  if (verbose) {
    console.log(`pushing ${messages.length} messages to ${sqsQueurUrl}`)
    console.log(`pushing thse messages in ${sqsBatches.length} batch(es) of ${SQS_BATCH_SIZE} or less with a pause of ${WAIT_BETWEEN_BATCHES} ms between each batch`)
  }

  for (let i = 0; i < sqsBatches.length; i++) {
    const batch = sqsBatches[i]

    await Promise.all(batch.map(async function anon(param) {
      await sqs.sendMessage(param).promise()
    }))

    if (i < sqsBatches.length - 1)
    await new Promise(resolve => setTimeout(resolve, WAIT_BETWEEN_BATCHES))
  }
}

async function logEvent(logsInstance, message, logGroupName, logStreamName) {

  const params = {
    logEvents: [
      {
        message: message,
        timestamp: Date.now()
      }
    ],
    logGroupName: logGroupName,
    logStreamName: logStreamName,
  }

  await logsInstance.putLogEvents(params).promise()
}

export { handler }
