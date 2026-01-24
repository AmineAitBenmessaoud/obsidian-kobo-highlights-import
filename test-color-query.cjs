// Test script to query Color values from KoboReader.sqlite
// Run with: node test-color-query.cjs path/to/KoboReader.sqlite

const fs = require('fs');
const SqlJs = require('sql.js');

async function testColorValues(dbPath) {
    try {
        if (!fs.existsSync(dbPath)) {
            console.error(`File not found: ${dbPath}`);
            process.exit(1);
        }

        console.log(`Reading database from: ${dbPath}\n`);
        
        const SQLEngine = await SqlJs();
        const dbBuffer = fs.readFileSync(dbPath);
        const db = new SQLEngine.Database(dbBuffer);

        console.log('\n=== Testing Color Values in Bookmark Table ===\n');

        // Query to see all unique Color values
        console.log('1. Unique Color values:');
        const colorValues = db.exec(
            `SELECT DISTINCT Color, COUNT(*) as count 
             FROM Bookmark 
             WHERE Text IS NOT NULL 
             GROUP BY Color 
             ORDER BY Color;`
        );
        
        if (colorValues[0]) {
            console.log('Color | Count');
            console.log('------|------');
            colorValues[0].values.forEach(row => {
                console.log(`${row[0] ?? 'NULL'} | ${row[1]}`);
            });
        }

        // Query to see sample bookmarks with their colors and text
        console.log('\n2. Sample bookmarks with Color values:');
        const samples = db.exec(
            `SELECT Text, Color, annotation 
             FROM Bookmark 
             WHERE Text IS NOT NULL 
             LIMIT 20;`
        );

        if (samples[0]) {
            console.log('Text (truncated) | Color | Has Note');
            console.log('-----------------|-------|----------');
            samples[0].values.forEach(row => {
                const text = row[0]?.toString().substring(0, 30) || 'N/A';
                const color = row[1] ?? 'NULL';
                const hasNote = row[2] ? 'Yes' : 'No';
                console.log(`${text.padEnd(30)} | ${color.toString().padEnd(5)} | ${hasNote}`);
            });
        }

        // Check if there's a Type column
        console.log('\n3. Checking for Type column:');
        const schema = db.exec("PRAGMA table_info(Bookmark);");
        if (schema[0]) {
            console.log('Column Name | Type');
            console.log('------------|-----');
            schema[0].values.forEach(row => {
                console.log(`${row[1]} | ${row[2]}`);
            });
        }

        // Query vocabulary-like words
        console.log('\n4. Sample short texts (likely vocabulary):');
        const vocab = db.exec(
            `SELECT Text, Color, LENGTH(Text) as len
             FROM Bookmark 
             WHERE Text IS NOT NULL 
             AND LENGTH(Text) < 30
             ORDER BY LENGTH(Text)
             LIMIT 10;`
        );

        if (vocab[0]) {
            console.log('Text | Color | Length');
            console.log('-----|-------|-------');
            vocab[0].values.forEach(row => {
                console.log(`${row[0]} | ${row[1] ?? 'NULL'} | ${row[2]}`);
            });
        }

        db.close();
    } catch (error) {
        console.error('Error:', error.message);
        console.error('\nUsage: node test-color-query.js <path-to-KoboReader.sqlite>');
    }
}

const dbPath = process.argv[2];
if (!dbPath) {
    console.error('Please provide path to KoboReader.sqlite');
    console.error('Usage: node test-color-query.js <path-to-KoboReader.sqlite>');
    console.error('Example: node test-color-query.js "E:\\.kobo\\KoboReader.sqlite"');
    process.exit(1);
}

testColorValues(dbPath);
