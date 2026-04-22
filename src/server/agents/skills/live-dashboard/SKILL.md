---
name: live-dashboard
description: Build interactive HTML dashboard artifacts with live database queries via the postMessage bridge. Includes a copy-paste helper function, workflow steps, and Chart.js integration patterns.
roles: [guide, conductor, reviewer, worker]
---

# Live Dashboard

Build self-contained HTML dashboards that query the user's databases in real time through the System2 postMessage bridge.

## Bridge Helper

Copy this helper into every dashboard. It wraps the raw postMessage protocol into a Promise-based API. Do not modify the field names (`type`, `requestId`, `sql`, `database`): the bridge matches on exact strings.

```js
function queryDatabase(sql, database) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    function handler(event) {
      const msg = event.data;
      if (msg.requestId !== requestId) return;
      if (msg.type === 'system2:query_result') {
        window.removeEventListener('message', handler);
        resolve(msg.rows);
      } else if (msg.type === 'system2:query_error') {
        window.removeEventListener('message', handler);
        reject(new Error(msg.error));
      }
    }
    window.addEventListener('message', handler);
    window.parent.postMessage({
      type: 'system2:query',
      requestId,
      sql,
      ...(database ? { database } : {})
    }, '*');
  });
}
```

Usage:

```js
// Query the user's analytical database
const rows = await queryDatabase('SELECT * FROM sales LIMIT 100', 'analytics');

// Query app.db (System2 metadata)
const projects = await queryDatabase('SELECT * FROM project');
```

## Workflow

1. **Identify the database.** Check `infrastructure.md` for the database name configured under `[databases.<name>]` in `config.toml`. Pass this name as the `database` argument.

2. **Explore the schema.** Query `information_schema` or equivalent to discover tables and columns before writing the dashboard SQL. For PostgreSQL: `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position`. For SQLite: `SELECT name, sql FROM sqlite_master WHERE type='table'`.

3. **Write the HTML file.** A single self-contained `.html` file with inline CSS and JS. Structure:

   ```
   <!DOCTYPE html>
   <html>
   <head>
     <meta charset="UTF-8">
     <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>  <!-- if needed -->
     <style>/* all styles inline */</style>
   </head>
   <body>
     <!-- controls and chart containers -->
     <script>
       // 1. queryDatabase helper (copy from above)
       // 2. DOM references
       // 3. Init: populate dropdowns/filters
       // 4. Render function
       // 5. Event listeners
     </script>
   </body>
   </html>
   ```

4. **Handle loading and errors.** Show a loading indicator while queries run. Display error messages in the UI rather than silently failing. Disable controls during data fetches to prevent race conditions.

5. **Register and show the artifact.** Use `write` to save the file to the project's artifact directory, then `show_artifact` to open it in the viewer.

## SQL Guidelines

- Only `SELECT`, `WITH ... SELECT` (CTEs), and `EXPLAIN` are allowed. The server rejects all mutations.
- Results are capped at `max_rows` (default 10,000). Use `LIMIT` for large tables.
- Queries time out after `query_timeout` seconds (default 30). Add `LIMIT` or filter clauses to keep queries fast.
- Parameterize values from UI controls carefully. The bridge does not support prepared statements, so build SQL strings in JavaScript. Avoid user-freetext in SQL; prefer dropdown selections populated from the database itself to minimize injection risk.

## Chart.js Patterns

Load from CDN: `https://cdn.jsdelivr.net/npm/chart.js`

```js
let chart = null;

function renderChart(labels, values, type = 'bar') {
  const ctx = document.getElementById('myChart').getContext('2d');
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: [{ label: 'Values', data: values }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false
    }
  });
}
```

## Common Patterns

**Populate a dropdown from a query:**

```js
async function populateSelect(selectId, sql, valueField, labelField, database) {
  const rows = await queryDatabase(sql, database);
  const select = document.getElementById(selectId);
  select.innerHTML = '';
  for (const row of rows) {
    const opt = document.createElement('option');
    opt.value = row[valueField];
    opt.textContent = row[labelField];
    select.appendChild(opt);
  }
}
```

**Multiple init queries in parallel:**

```js
await Promise.all([
  populateSelect('countrySelect', 'SELECT code, name FROM country ORDER BY name', 'code', 'name', 'analytics'),
  populateSelect('yearSelect', 'SELECT DISTINCT year FROM data ORDER BY year DESC', 'year', 'year', 'analytics'),
]);
// All dropdowns ready, trigger initial render
fetchAndRender();
```

## Checklist

Before calling `show_artifact`:

- [ ] `queryDatabase` helper uses exact field names (`type`, `requestId`, `sql`, `database`)
- [ ] Database name matches a `[databases.<name>]` entry in the user's config
- [ ] All SQL is read-only (SELECT/CTE/EXPLAIN)
- [ ] Loading states shown during queries
- [ ] Errors displayed to the user, not swallowed
- [ ] Chart containers have explicit height (Chart.js needs it)
- [ ] File is self-contained (no external dependencies besides CDN scripts)
