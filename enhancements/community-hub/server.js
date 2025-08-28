const express = require('express');
const cors = require('cors');
const db = require('./db.json');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
const port = 3001;

let loggedInUser = null;

app.use(cors());
app.use(express.json());

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const userExists = db.users.find(u => u.username === username);
    if (userExists) {
        return res.status(400).json({ error: 'User already exists' });
    }

    const newUser = { username, password };
    db.users.push(newUser);
    fs.writeFileSync(path.join(__dirname, 'db.json'), JSON.stringify(db, null, 2));

    res.json({ message: 'User registered successfully' });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.users.find(u => u.username === username && u.password === password);
    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    loggedInUser = user;
    res.json({ message: 'Logged in successfully' });
});

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

app.post('/api/threads', (req, res) => {
    if (!loggedInUser) {
        return res.status(401).json({ error: 'You must be logged in to create a thread' });
    }

    const { title, content } = req.body;
    if (!title || !content) {
        return res.status(400).json({ error: 'Title and content are required' });
    }

    const newThread = {
        id: db.threads.length + 1,
        title,
        author: loggedInUser.username,
        posts: [{ author: loggedInUser.username, content }]
    };

    db.threads.push(newThread);
    fs.writeFileSync(path.join(__dirname, 'db.json'), JSON.stringify(db, null, 2));

    res.json(newThread);
});

app.post('/api/threads/:id/posts', (req, res) => {
    if (!loggedInUser) {
        return res.status(401).json({ error: 'You must be logged in to post a reply' });
    }

    const id = parseInt(req.params.id);
    const thread = db.threads.find(t => t.id === id);
    if (!thread) {
        return res.status(404).json({ error: 'Thread not found' });
    }

    const { content } = req.body;
    if (!content) {
        return res.status(400).json({ error: 'Content is required' });
    }

    const newPost = {
        author: loggedInUser.username,
        content
    };

    thread.posts.push(newPost);
    fs.writeFileSync(path.join(__dirname, 'db.json'), JSON.stringify(db, null, 2));

    const postData = JSON.stringify({
        achievementId: 'community-helper'
    });

    const options = {
        hostname: 'localhost',
        port: 3003,
        path: `/api/users/${loggedInUser.username}/achievements`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const req = http.request(options);
    req.on('error', () => {});
    req.write(postData);
    req.end();

    res.json(thread);
});

app.listen(port, () => {
    console.log(`Community Hub server listening at http://localhost:${port}`);
});
