const tutorials = {
    "getting-started": {
        title: "Getting Started",
        content: `
            <p>This tutorial will walk you through the basics of Qwen Code.</p>
            <h3>Exercise 1: What is the command to start the interactive CLI?</h3>
            <input type="text" id="ex1-input">
            <button onclick="checkAnswer('ex1', 'qwen')">Check Answer</button>
            <p id="ex1-result"></p>
        `
    },
    "exploring-code": {
        title: "Exploring Code",
        content: `
            <p>Learn how to use Qwen Code to explore a new codebase.</p>
            <h3>Exercise 2: What is a good prompt to understand the architecture of a project?</h3>
            <input type="text" id="ex2-input">
            <button onclick="checkAnswer('ex2', 'Describe the main pieces of this system\\'s architecture.')">Check Answer</button>
            <p id="ex2-result"></p>
        `
    },
    "refactoring": {
        title: "Refactoring",
        content: `
            <p>Discover how Qwen Code can help you refactor your code.</p>
            <p>There are no exercises for this tutorial yet.</p>
        `
    }
};

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
    if (input.value.trim().toLowerCase() === correctAnswer.toLowerCase()) {
        result.textContent = "Correct!";
        result.style.color = "green";
    } else {
        result.textContent = "Incorrect. Please try again.";
        result.style.color = "red";
    }
}
