// Renders sample.html, tables.html and figures.html to PDFs the way the challenge's PDFs were
// made: headless Chrome with the footer "UN R999, version 2.1.0 | page n of N". Run from anywhere
// Playwright is installed:
//   node agent/tests/fixtures/regulation/make_sample.cjs
const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const name of ["sample", "tables", "figures"]) {
    await page.goto(`file://${path.join(__dirname, `${name}.html`)}`);
    await page.pdf({
      path: path.join(__dirname, `${name}.pdf`),
      format: "A4",
      margin: { top: "15mm", bottom: "20mm", left: "15mm", right: "15mm" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="font-size: 10.7pt; width: 100%; text-align: center;">UN R999, version 2.1.0 | ' +
        'page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
  }
  await browser.close();
})();
