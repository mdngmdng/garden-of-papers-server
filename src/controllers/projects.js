const { getClient } = require('../services/mongo');

// POST /find-projectName
exports.findProjectName = async (req, res) => {
  try {
    const client = getClient();
    const db = client.db('UserNameList');
    const collection = db.collection(req.body.userName);
    const data = await collection.find().toArray();
    res.status(200).json(data);
  } catch (error) {
    console.error('Failed to load data:', error);
    res.status(500).json({ status: 'error', message: 'Failed to load data', data: error });
  }
};

// POST /create-new-project
exports.createNewProject = async (req, res) => {
  try {
    const client = getClient();
    const existingDbs = await client.db().admin().listDatabases();
    const dbNames = existingDbs.databases.map((db) => db.name);

    if (dbNames.includes(req.body.projectName)) {
      return res.status(202).json({ message: 'The project name already exists. Please use a different name.' });
    }

    const db = client.db('UserNameList');
    const collection = db.collection(req.body.userName);
    await collection.insertOne({ projectName: req.body.projectName });

    const newDB = client.db(req.body.projectName);
    const newCollection = newDB.collection('SaveFile');
    const newData = await newCollection.insertOne({});

    res.status(200).json(newData);
  } catch (error) {
    console.error('Failed to create project:', error);
    res.status(500).json({ status: 'error', message: 'Failed to create project', data: error });
  }
};
