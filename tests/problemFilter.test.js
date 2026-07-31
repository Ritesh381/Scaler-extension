const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

test("problem filter bar uses a subtle, native-looking toolbar style", () => {
  const { window } = loadFeature(["content/features/problemFilter.js"], {
    url: "https://www.scaler.com/academy/problems",
    html: `
      <div>
        <table>
          <tbody>
            <tr class="table__row">
              <td><div class="me-cr-problem-list__name">Two Sum</div></td>
              <td><span class="me-cr-problem-list__judge-type cr-icon-code"></span></td>
              <td>Easy</td>
              <td>100/100</td>
              <td>Solved</td>
              <td>1 submission</td>
            </tr>
          </tbody>
        </table>
      </div>
    `,
  });

  window.isProblemsPage = () => true;

  const injected = window.injectProblemFilters();

  assert.equal(injected, true);

  const style = window.document.getElementById("scaler-problem-filter-styles");
  assert.ok(style, "expected the filter styles to be injected");

  const css = style.textContent;
  assert.match(css, /background:\s*transparent;/);
  assert.match(css, /border-bottom:\s*1px solid #e5e7eb;/);
  assert.match(css, /box-shadow:\s*none;/);
});
