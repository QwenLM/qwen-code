const express = require('express');
const cors = require('cors');
const plugins = require('./plugins.json');

const app = express();
const port = 3002;

app.use(cors());

app.get('/api/plugins', (req, res) => {
    res.json(plugins);
});

app.listen(port, () => {
    console.log(`Plugin Marketplace server listening at http://localhost:${port}`);
});
