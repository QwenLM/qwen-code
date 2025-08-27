// Mock localStorage
const localStorageMock = (function() {
    let store = {};
    return {
        getItem: function(key) {
            return store[key] || null;
        },
        setItem: function(key, value) {
            store[key] = value.toString();
        },
        clear: function() {
            store = {};
        }
    };
})();

Object.defineProperty(window, 'localStorage', {
    value: localStorageMock
});

// Mock the DOM elements
document.body.innerHTML = `
    <ul id="tutorial-list">
        <li data-tutorial="getting-started">Getting Started</li>
        <li data-tutorial="exploring-code">Exploring Code</li>
    </ul>
    <section id="tutorial-content" data-tutorial-id=""></section>
`;

// The script is loaded via a <script> tag in the test HTML, so functions are global
const scriptFunctions = require('../lib/learning-platform.js');


describe('Progress Tracking', () => {
    beforeEach(() => {
        // Clear localStorage and reset progress before each test
        localStorage.clear();
        global.progress = scriptFunctions.getProgress();

        // Reset the completed class on the tutorial list
        const tutorialListItems = document.querySelectorAll('#tutorial-list li');
        tutorialListItems.forEach(item => {
            item.classList.remove('completed');
        });
    });

    test('should get empty progress if nothing is saved', () => {
        expect(scriptFunctions.getProgress()).toEqual({ completedTutorials: [] });
    });

    test('should save progress to localStorage', () => {
        global.progress.completedTutorials.push('getting-started');
        scriptFunctions.saveProgress();
        const savedProgress = JSON.parse(localStorage.getItem('qwen-code-learning-progress'));
        expect(savedProgress).toEqual({ completedTutorials: ['getting-started'] });
    });

    test('should mark a tutorial as complete', () => {
        scriptFunctions.markTutorialAsComplete('exploring-code');
        expect(global.progress.completedTutorials).toContain('exploring-code');
    });

    test('should not add a tutorial to completed list if it is already there', () => {
        scriptFunctions.markTutorialAsComplete('exploring-code');
        scriptFunctions.markTutorialAsComplete('exploring-code');
        expect(global.progress.completedTutorials).toEqual(['exploring-code']);
    });
});
