const { MongoClient } = require('mongodb');
const config = require('../config');

let client;

async function connect() {
  client = new MongoClient(config.mongoUrl);
  await client.connect();
  console.log('MongoDB connected');
  return client;
}

function getClient() {
  return client;
}

module.exports = { connect, getClient };
