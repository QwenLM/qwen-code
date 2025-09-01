const tutorials = {
    "getting-started": {
        title: "Getting Started",
        content: `
            <p>This tutorial will walk you through the basics of Qwen Code. We'll cover installation, configuration, and your first commands.</p>
            <p>Qwen Code is a powerful tool, and getting the setup right is the first step to unlocking its potential.</p>
            <h3>Exercise 1: What is the command to start the interactive CLI?</h3>
            <input type="text" id="ex1-input">
            <button onclick="checkAnswer('ex1', 'qwen')">Check Answer</button>
            <p id="ex1-result"></p>
        `
    },
    "exploring-code": {
        title: "Exploring Code",
        content: `
            <p>Learn how to use Qwen Code to explore a new codebase. This is one of the most common use cases for Qwen Code.</p>
            <p>You can ask questions about the architecture, dependencies, and even specific functions.</p>
            <h3>Exercise 2: What is a good prompt to understand the architecture of a project?</h3>
            <input type="text" id="ex2-input">
            <button onclick="checkAnswer('ex2', 'Describe the main pieces of this system\\'s architecture.')">Check Answer</button>
            <p id="ex2-result"></p>
        `
    },
    "refactoring": {
        title: "Refactoring",
        content: `
            <p>Discover how Qwen Code can help you refactor your code. You can ask it to improve readability, performance, or to adhere to specific design patterns.</p>
            <h3>Exercise 3: What command would you use to ask Qwen Code to refactor a function called 'myFunction'?</h3>
            <input type="text" id="ex3-input">
            <button onclick="checkAnswer('ex3', 'refactor the function myFunction')">Check Answer</button>
            <p id="ex3-result"></p>
        `
    },
    "automating-tasks": {
        title: "Automating Tasks",
        content: `
            <p>Qwen Code can automate a wide range of development tasks, from generating documentation to writing unit tests.</p>
            <h3>Exercise 4: What prompt would you use to generate unit tests for a file called 'utils.js'?</h3>
            <input type="text" id="ex4-input">
            <button onclick="checkAnswer('ex4', 'generate unit tests for utils.js')">Check Answer</button>
            <p id="ex4-result"></p>
        `
    },
    "working-with-plugins": {
        title: "Working with Plugins",
        content: `
            <p>Qwen Code can be extended with plugins to add new functionality.</p>
            <p>This tutorial will cover how to install and use plugins from the marketplace.</p>
            <p>There are no exercises for this tutorial yet.</p>
        `
    }
};

// For testing purposes
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getProgress,
        saveProgress,
        markTutorialAsComplete,
        set progress(p) { progress = p; },
        get progress() { return progress; }
    };
}

let progress = getProgress();

document.addEventListener('DOMContentLoaded', () => {
    updateTutorialList();
});

document.getElementById('tutorial-list').addEventListener('click', (event) => {
    if (event.target.tagName === 'LI') {
        const tutorialId = event.target.dataset.tutorial;
        loadTutorial(tutorialId);
    }
});

function loadTutorial(tutorialId) {
    const tutorial = tutorials[tutorialId];
    const tutorialContent = document.getElementById('tutorial-content');
    tutorialContent.innerHTML = `
        <h2>${tutorial.title}</h2>
        ${tutorial.content}
    `;
}

function checkAnswer(exerciseId, correctAnswer) {
    const input = document.getElementById(`${exerciseId}-input`);
    const result = document.getElementById(`${exerciseId}-result`);
    const tutorialId = input.closest('section').dataset.tutorialId;

    if (input.value.trim().toLowerCase() === correctAnswer.toLowerCase()) {
        result.textContent = "Correct!";
        result.style.color = "green";
        markTutorialAsComplete(tutorialId);
    } else {
        result.textContent = "Incorrect. Please try again.";
        result.style.color = "red";
    }
}

function getProgress() {
    const savedProgress = localStorage.getItem('qwen-code-learning-progress');
    return savedProgress ? JSON.parse(savedProgress) : { completedTutorials: [] };
}

function saveProgress() {
    localStorage.setItem('qwen-code-learning-progress', JSON.stringify(progress));
}

function markTutorialAsComplete(tutorialId) {
    if (!progress.completedTutorials.includes(tutorialId)) {
        progress.completedTutorials.push(tutorialId);
        saveProgress();
        updateTutorialList();
    }
}

function updateTutorialList() {
    const tutorialListItems = document.querySelectorAll('#tutorial-list li');
    tutorialListItems.forEach(item => {
        const tutorialId = item.dataset.tutorial;
        if (progress.completedTutorials.includes(tutorialId)) {
            item.classList.add('completed');
        }
    });
}

// Modify the loadTutorial function to store the current tutorial id
function loadTutorial(tutorialId) {
    const tutorial = tutorials[tutorialId];
    const tutorialContent = document.getElementById('tutorial-content');
    tutorialContent.dataset.tutorialId = tutorialId;
    tutorialContent.innerHTML = `
        <h2>${tutorial.title}</h2>
        ${tutorial.content}
    `;
}
