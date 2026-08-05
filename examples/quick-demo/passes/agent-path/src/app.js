'use strict';

const express = require('express');
const app = express();

app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'ok',
    time: new Date().toISOString()
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'not found'
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({
    error: 'internal server error'
  });
});

module.exports = app;
