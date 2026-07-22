const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Read the markdown.js file as a string and eval it so we can test the pure function
const markdownSrc = fs.readFileSync(path.join(__dirname, '../extension-main/content/features/assignmentExport/markdown.js'), 'utf8');
eval(markdownSrc); // Brings generateMarkdown into scope

test('Assignment Export - Markdown Generation', async (t) => {
    
    await t.test('Generates basic markdown with correct metadata', () => {
        const input = {
            title: 'Test Problem',
            sessionTitle: 'Test Session',
            questionNumber: '03',
            questionType: 'Coding',
            statement: 'This is the statement.',
            mcqOptions: null,
            code: 'console.log("hello");'
        };
        const md = generateMarkdown(input);
        
        assert.match(md, /# Test Problem/);
        assert.match(md, /\*\*Session:\*\*\nTest Session/);
        assert.match(md, /\*\*Question Number:\*\*\n03/);
        assert.match(md, /\*\*Question Type:\*\*\nCoding/);
        assert.match(md, /## Problem Statement\nThis is the statement\./);
        assert.match(md, /## Code\n````\nconsole\.log\("hello"\);\n````/);
    });

    await t.test('Handles MCQ correctly and skips code fence', () => {
        const input = {
            title: 'MCQ Problem',
            sessionTitle: 'Test Session',
            questionNumber: '01',
            questionType: 'Single Correct MCQ',
            statement: 'What is 2+2?',
            mcqOptions: '## Options\n- [ ] **A)** 3\n- [ ] **B)** 4',
            code: ''
        };
        const md = generateMarkdown(input);
        
        assert.match(md, /## Options/);
        assert.match(md, /- \[ \] \*\*B\)\*\* 4/);
        assert.doesNotMatch(md, /## Code/);
    });

    await t.test('Handles missing fields gracefully', () => {
        const md = generateMarkdown({});
        assert.match(md, /# Assignment/);
        assert.match(md, /\*\*Session:\*\*\nUnknown/);
        assert.match(md, /## Problem Statement\nNo problem statement found\./);
    });
});
