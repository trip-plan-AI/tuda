const { Client } = require('pg');

async function test() {
  const client = new Client({
    connectionString: 'postgresql://travel_user:travel_password@localhost:5432/travel_planner'
  });
  await client.connect();
  try {
    const res = await client.query(`
      INSERT INTO trips (title, budget, is_active, version)
      VALUES ('Test trip', 0, false, 0)
      RETURNING *;
    `);
    console.log('Success!', res.rows[0]);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await client.end();
  }
}
test();
