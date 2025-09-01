const express = require('express');
const cors = require('cors');
const db = require('./db.json');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3003;

app.use(cors());
app.use(express.json());

app.get('/api/users/:username', (req, res) => {
    const username = req.params.username;
    const user = db.users[username];
    if (user) {
        res.json(user);
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

app.get('/api/leaderboard', (req, res) => {
    const users = Object.values(db.users);
    const sortedUsers = users.sort((a, b) => b.points - a.points);
    const top10 = sortedUsers.slice(0, 10);
    res.json(top10);
});

app.post('/api/users/:username/achievements', (req, res) => {
    const username = req.params.username;
    const { achievementId } = req.body;

    const user = db.users[username];
    const achievement = db.achievements.find(a => a.id === achievementId);

    if (!user || !achievement) {
        return res.status(404).json({ error: 'User or achievement not found' });
    }

    if (!user.achievements.includes(achievement.name)) {
        user.achievements.push(achievement.name);
        user.points += achievement.points;

        fs.writeFileSync(path.join(__dirname, 'db.json'), JSON.stringify(db, null, 2));
    }

    res.json(user);
});

app.listen(port, () => {
    console.log(`Gamification server listening at http://localhost:${port}`);
});
