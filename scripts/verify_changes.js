const fs = require('fs');

const files = [
  './services/pdfReportService.js',
  './screens/admin/AdminAdvancedSearchScreen.js',
  './components/PlatformMap.native.js',
  './screens/admin/AdminLocationMapScreen.js',
  './screens/RealTimeFaceScanScreen.js',
  './screens/admin/SuperAdminAttendanceSettingsScreen.js',
  './screens/admin/AdminEmployeeHistoryScreen.js',
  './screens/admin/AdminDashboardScreen.js',
  './screens/admin/AdminAttendanceScreen.js'
];

console.log('Verifying files exist and are readable...');
let allValid = true;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error('❌ Missing file:', file);
    allValid = false;
    continue;
  }
  const content = fs.readFileSync(file, 'utf8');
  if (content.length === 0) {
    console.error('❌ Empty file:', file);
    allValid = false;
    continue;
  }
  console.log(`✅ ${file}: ${content.length} bytes`);
}

if (allValid) {
  console.log('\n🎉 All target files verified successfully!');
} else {
  process.exit(1);
}
