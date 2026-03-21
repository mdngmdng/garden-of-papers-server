const express = require('express');
const router = express.Router();
const projectsController = require('../controllers/projects');

router.post('/find-projectName', projectsController.findProjectName);
router.post('/create-new-project', projectsController.createNewProject);

module.exports = router;
