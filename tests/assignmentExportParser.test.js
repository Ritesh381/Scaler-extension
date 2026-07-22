const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Utility to create JSDOM with innerText polyfilled
function createDOM(html) {
    const dom = new JSDOM(html);
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
        get() {
            return this.textContent;
        }
    });
    return dom;
}

const parserSrc = fs.readFileSync(path.join(__dirname, '../extension-main/content/utils/assignmentParser.js'), 'utf8');
eval(parserSrc);

test('Assignment Export - Parser', async (t) => {
    
    await t.test('extractProblemTitle extracts title correctly', () => {
        const dom = createDOM(`
            <body>
                <div class="cr-p-heading__text">
                    <span>Q1. Problem Name</span>
                </div>
            </body>
        `);
        const title = extractProblemTitle(dom.window.document);
        assert.strictEqual(title, 'Problem Name');
    });

    await t.test('extractProblemStatement extracts statement', () => {
        const dom = createDOM(`
            <body>
                <div class="cr-p-problem-statement">
                    This is a problem statement that is definitely longer than forty characters so it gets extracted.
                </div>
            </body>
        `);
        const stmt = extractProblemStatement(dom.window.document);
        assert.strictEqual(stmt, 'This is a problem statement that is definitely longer than forty characters so it gets extracted.');
    });

    await t.test('determineQuestionType detects MCQs', () => {
        const domMultiple = createDOM(`<body><input type="checkbox" /></body>`);
        assert.strictEqual(determineQuestionType(domMultiple.window.document, "Options"), 'Multiple Correct MCQ');

        const domSingle = createDOM(`<body><input type="radio" /></body>`);
        assert.strictEqual(determineQuestionType(domSingle.window.document, "Options"), 'Single Correct MCQ');

        const domCoding = createDOM(`<body></body>`);
        assert.strictEqual(determineQuestionType(domCoding.window.document, ""), 'Coding');
    });

    await t.test('extractSessionTitle extracts header title', () => {
        const dom = createDOM(`<body><div class="header-title">Concurrency</div></body>`);
        assert.strictEqual(extractSessionTitle(dom.window.document), 'Concurrency');
    });
});
