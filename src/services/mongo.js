const { MongoClient } = require('mongodb');
const { createHash } = require('node:crypto');
const config = require('../config');

let client;

const INVALID_DATABASE_NAME = /[\/\\."$*<>:|?\u0000]/u;

function projectDatabaseName(value) {
  if (typeof value !== 'string' || !INVALID_DATABASE_NAME.test(value)) {
    return value;
  }
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `gop_project_${digest}`;
}

async function connect() {
  client = new MongoClient(config.mongoUrl);
  await client.connect();
  const openDatabase = client.db.bind(client);
  client.db = (databaseName, options) => (
    openDatabase(projectDatabaseName(databaseName), options)
  );
  console.log('MongoDB connected');
  return client;
}

function getClient() {
  return client;
}

module.exports = { connect, getClient, projectDatabaseName };
