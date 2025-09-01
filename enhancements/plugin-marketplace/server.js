const express = require('express');
const cors = require('cors');
const plugins = require('./plugins.json');
const pendingPlugins = require('./pending-plugins.json');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3002;

app.use(cors());
app.use(express.json());

app.get('/api/plugins', (req, res) => {
    res.json(plugins);
});

app.post('/api/plugins/submit', (req, res) => {
    const newPlugin = req.body;
    if (!newPlugin || !newPlugin.name || !newPlugin.description || !newPlugin.author) {
        return res.status(400).json({ error: 'Invalid plugin data' });
    }

    pendingPlugins.push(newPlugin);
    fs.writeFileSync(path.join(__dirname, 'pending-plugins.json'), JSON.stringify(pendingPlugins, null, 2));

    res.json({ message: 'Plugin submitted successfully' });
});

app.get('/api/plugins/pending', (req, res) => {
    res.json(pendingPlugins);
});

app.post('/api/plugins/approve/:id', (req, res) => {
    const pluginId = req.params.id;
    const pluginIndex = pendingPlugins.findIndex(p => p.id === pluginId);

    if (pluginIndex === -1) {
        return res.status(404).json({ error: 'Plugin not found' });
    }

    const [approvedPlugin] = pendingPlugins.splice(pluginIndex, 1);
    plugins.plugins.push(approvedPlugin);

    fs.writeFileSync(path.join(__dirname, 'pending-plugins.json'), JSON.stringify(pendingPlugins, null, 2));
    fs.writeFileSync(path.join(__dirname, 'plugins.json'), JSON.stringify(plugins, null, 2));

    res.json({ message: 'Plugin approved successfully' });
});


app.listen(port, () => {
    console.log(`Plugin Marketplace server listening at http://localhost:${port}`);
});
