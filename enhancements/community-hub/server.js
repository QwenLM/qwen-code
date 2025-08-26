const express = require('express');
const cors = require('cors');
const db = require('./db.json');

const app = express();
const port = 3001;

app.use(cors());

app.get('/api/threads', (req, res) => {
    res.json(db.threads);
});

app.get('/api/threads/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const thread = db.threads.find(t => t.id === id);
    if (thread) {
        res.json(thread);
    } else {
        res.status(404).json({ error: 'Thread not found' });
    }
});

app.listen(port, () => {
    console.log(`Community Hub server listening at http://localhost:${port}`);
});
