const express = require('express');

const app = express();
const PORT = 60100;

// Home route
app.get('/', (req, res) => {
  res.send('<h1>Home</h1>');
});

// Test route
app.get('/test', (req, res) => {
  res.send('<h1>Hell Test Page</h1>');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});