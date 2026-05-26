require('dotenv').config();
const fetch = require('node-fetch');
const FormData = require('form-data');

const ACCESS = process.env.HIVE_API_KEY;
const SECRET = process.env.HIVE_SECRET_KEY;

console.log('Access Key:', ACCESS);
console.log('Secret Key:', SECRET ? SECRET.slice(0,6)+'...' : 'MISSING');

const tinyJpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB/8QAIRAAAQQDAQADAQAAAAAAAAAAAQIDBAURBhIhMUH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Aqq1NpWiVy1XLLiTS3DszJ+SQCAwA','base64');

async function test(authHeader, label) {
  try {
    const fd = new FormData();
    fd.append('image', tinyJpeg, { filename: 'test.jpg', contentType: 'image/jpeg' });
    const r = await fetch('https://api.thehive.ai/api/v3/task/sync', {
      method: 'POST',
      headers: { 'Authorization': authHeader, ...fd.getHeaders() },
      body: fd
    });
    const text = await r.text();
    console.log('\n' + label + ': STATUS ' + r.status);
    console.log('Response:', text.slice(0, 150));
  } catch(e) {
    console.log('\n' + label + ': ERROR - ' + e.message);
  }
}

async function run() {
  console.log('\n--- Testing all auth formats ---\n');
  await test('Token ' + ACCESS, 'Token ACCESS_KEY');
  await test('Token ' + SECRET, 'Token SECRET_KEY');
  await test('Bearer ' + ACCESS, 'Bearer ACCESS_KEY');
  await test('Bearer ' + SECRET, 'Bearer SECRET_KEY');
  const combined = Buffer.from(ACCESS + ':' + SECRET).toString('base64');
  await test('Basic ' + combined, 'Basic ACCESS:SECRET');
}

run();