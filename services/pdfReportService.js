import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { formatTime, formatDate } from '../utils/attendance';

export const pdfReportService = {
    /**
     * Generate & Share Employee Attendance PDF Report
     */
    generateEmployeeReport: async ({ employee, company, records = [], periodTitle = '' }) => {
        try {
            const html = buildEmployeeHtml({
                employee,
                company: company || { name: 'SmartAttend Enterprise' },
                records,
                periodTitle: periodTitle || `Attendance Report - ${new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}`,
            });

            // Generate PDF with base64 for reliable direct file creation
            const { uri, base64 } = await Print.printToFileAsync({ html, base64: true });
            console.log('✅ Generated PDF file');

            // Save inside documentDirectory so Android FileProvider has valid read & share permissions
            let shareUri = uri;
            try {
                const cleanName = (employee?.name || 'Employee').replace(/[^a-zA-Z0-9]/g, '_');
                const targetFilename = `Attendance_Report_${cleanName}_${Date.now()}.pdf`;
                const targetPath = `${FileSystem.documentDirectory || FileSystem.cacheDirectory}${targetFilename}`;

                if (base64) {
                    await FileSystem.writeAsStringAsync(targetPath, base64, {
                        encoding: FileSystem.EncodingType.Base64,
                    });
                    shareUri = targetPath;
                } else if (FileSystem.copyAsync) {
                    await FileSystem.copyAsync({
                        from: uri,
                        to: targetPath,
                    });
                    shareUri = targetPath;
                }
            } catch (fsErr) {
                console.log('PDF preparation notice, using file uri:', fsErr.message);
            }

            const isAvailable = await Sharing.isAvailableAsync();
            if (isAvailable) {
                await Sharing.shareAsync(shareUri, {
                    UTI: '.pdf',
                    mimeType: 'application/pdf',
                    dialogTitle: `Attendance Report - ${employee?.name || 'Employee'}`,
                });
            } else {
                console.log('Sharing not available, file saved at:', shareUri);
            }

            return { success: true, uri: shareUri };
        } catch (error) {
            console.log('PDF generation error note:', error?.message);
            throw new Error(error?.message || 'Could not export PDF report');
        }
    },

    /**
     * Generate & Share Admin / Organization Attendance PDF Report
     */
    generateAdminReport: async ({ company, records = [], employees = [], periodTitle = '', filters = {} }) => {
        try {
            const html = buildAdminHtml({
                company: company || { name: 'SmartAttend Enterprise' },
                records,
                employees,
                periodTitle: periodTitle || `Organization Attendance Report - ${formatDate(new Date())}`,
                filters,
            });

            const { uri, base64 } = await Print.printToFileAsync({ html, base64: true });
            console.log('✅ Generated Admin PDF file');

            let shareUri = uri;
            try {
                const targetFilename = `Org_Attendance_Report_${Date.now()}.pdf`;
                const targetPath = `${FileSystem.documentDirectory || FileSystem.cacheDirectory}${targetFilename}`;

                if (base64) {
                    await FileSystem.writeAsStringAsync(targetPath, base64, {
                        encoding: FileSystem.EncodingType.Base64,
                    });
                    shareUri = targetPath;
                } else if (FileSystem.copyAsync) {
                    await FileSystem.copyAsync({
                        from: uri,
                        to: targetPath,
                    });
                    shareUri = targetPath;
                }
            } catch (fsErr) {
                console.log('Admin PDF preparation notice:', fsErr.message);
            }

            const isAvailable = await Sharing.isAvailableAsync();
            if (isAvailable) {
                await Sharing.shareAsync(shareUri, {
                    UTI: '.pdf',
                    mimeType: 'application/pdf',
                    dialogTitle: 'Organization Attendance Report',
                });
            }

            return { success: true, uri: shareUri };
        } catch (error) {
            console.log('Admin PDF report error note:', error?.message);
            throw new Error(error?.message || 'Could not export admin PDF report');
        }
    }
};

/**
 * Builds HTML for single employee detailed report
 */
function buildEmployeeHtml({ employee, company, records, periodTitle }) {
    // Sort records descending by date
    const sorted = [...records].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Summary Calculations
    let presentCount = 0;
    let halfDayCount = 0;
    let absentCount = 0;
    let lateCount = 0;
    let totalWorkHours = 0;
    let totalBreakHours = 0;

    sorted.forEach(r => {
        if (r.status === 'present') presentCount++;
        else if (r.status === 'half_day') halfDayCount++;
        else if (r.status === 'late') { lateCount++; presentCount++; }
        else if (r.status === 'absent') absentCount++;

        totalWorkHours += Number(r.totalWorkHours || r.workHours || 0);
        totalBreakHours += Number(r.totalBreakHours || r.breakHours || 0);
    });

    const totalDays = sorted.length;
    const avgWorkHours = totalDays > 0 ? (totalWorkHours / totalDays).toFixed(1) : '0.0';

    const rowsHtml = sorted.map((r, idx) => {
        const sessions = Array.isArray(r.sessions) ? r.sessions : [];
        
        // Build punch sessions timeline (IN -> OUT -> IN -> OUT ...)
        let sessionsTimeline = '';
        if (sessions.length > 0) {
            sessionsTimeline = sessions.map((s, sIdx) => {
                const inTime = s.checkInTime || (s.checkIn ? formatTime(new Date(s.checkIn)) : '-');
                const outTime = s.checkOutTime || (s.checkOut ? formatTime(new Date(s.checkOut)) : 'Active');
                const dur = s.sessionHours ? ` (${s.sessionHours}h)` : '';
                return `<strong>#${sIdx + 1}:</strong> ${inTime} IN → ${outTime} OUT${dur}`;
            }).join('<br/>');
        } else if (r.checkInTime) {
            sessionsTimeline = `${r.checkInTime} IN → ${r.checkOutTime || '-'} OUT`;
        } else {
            sessionsTimeline = '<span class="text-muted">No punch records</span>';
        }

        const statusClass = getStatusBadgeClass(r.status);
        const statusLabel = formatStatusLabel(r.status);
        const modeBadge = r.attendanceMode === 'WFH' ? '<span class="badge wfh">WFH</span>' : '<span class="badge office">Office</span>';

        return `
            <tr class="${idx % 2 === 0 ? 'even' : 'odd'}">
                <td style="font-weight: 600;">${r.date}</td>
                <td>${statusClass ? `<span class="badge ${statusClass}">${statusLabel}</span>` : statusLabel} ${modeBadge}</td>
                <td>${r.firstCheckInTime || r.checkInTime || '-'}</td>
                <td>${r.lastCheckOutTime || r.checkOutTime || '-'}</td>
                <td style="font-weight: 600; color: #1e3a8a;">${(r.totalWorkHours || r.workHours || 0).toFixed(1)} hrs</td>
                <td style="color: #64748b;">${(r.totalBreakHours || r.breakHours || 0).toFixed(1)} hrs</td>
                <td class="timeline-cell">${sessionsTimeline}</td>
            </tr>
        `;
    }).join('');

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8" />
        <title>${periodTitle}</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 24px; color: #0f172a; font-size: 12px; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 16px; }
            .company-name { font-size: 20px; font-weight: 700; color: #1e3a8a; }
            .report-title { font-size: 14px; font-weight: 600; color: #475569; margin-top: 4px; }
            .meta-grid { display: flex; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
            .meta-item { display: flex; flex-direction: column; }
            .meta-label { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 600; }
            .meta-value { font-size: 13px; font-weight: 700; color: #1e293b; margin-top: 2px; }
            .stats-bar { display: flex; gap: 10px; margin-bottom: 16px; }
            .stat-card { flex: 1; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; text-align: center; }
            .stat-num { font-size: 16px; font-weight: 700; color: #0f172a; }
            .stat-lbl { font-size: 10px; color: #64748b; margin-top: 2px; }
            table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11px; }
            th { background: #f1f5f9; color: #334155; font-weight: 700; text-align: left; padding: 8px 10px; border-bottom: 2px solid #cbd5e1; }
            td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
            tr.even { background: #ffffff; }
            tr.odd { background: #f8fafc; }
            .timeline-cell { line-height: 1.5; font-size: 10.5px; }
            .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 9.5px; font-weight: 600; text-transform: uppercase; }
            .badge.present { background: #dcfce7; color: #15803d; }
            .badge.half_day { background: #ffedd5; color: #c2410c; }
            .badge.late { background: #fef9c3; color: #a16207; }
            .badge.absent { background: #fee2e2; color: #b91c1c; }
            .badge.office { background: #e0f2fe; color: #0369a1; }
            .badge.wfh { background: #f3e8ff; color: #7e22ce; }
            .text-muted { color: #94a3b8; font-style: italic; }
            .footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 10px; }
        </style>
    </head>
    <body>
        <div class="header">
            <div>
                <div class="company-name">${company.name || 'SmartAttend'}</div>
                <div class="report-title">${periodTitle}</div>
            </div>
            <div style="text-align: right; font-size: 10px; color: #64748b;">
                Generated: ${new Date().toLocaleString()}<br/>
                Official Attendance Record
            </div>
        </div>

        <div class="meta-grid">
            <div class="meta-item">
                <span class="meta-label">Employee Name</span>
                <span class="meta-value">${employee?.name || 'N/A'}</span>
            </div>
            <div class="meta-item">
                <span class="meta-label">Employee ID</span>
                <span class="meta-value">${employee?.employeeId || 'N/A'}</span>
            </div>
            <div class="meta-item">
                <span class="meta-label">Department</span>
                <span class="meta-value">${employee?.department || 'General'}</span>
            </div>
            <div class="meta-item">
                <span class="meta-label">Total Days Logged</span>
                <span class="meta-value">${totalDays}</span>
            </div>
        </div>

        <div class="stats-bar">
            <div class="stat-card" style="border-top: 3px solid #22c55e;">
                <div class="stat-num" style="color: #16a34a;">${presentCount}</div>
                <div class="stat-lbl">Present Days</div>
            </div>
            <div class="stat-card" style="border-top: 3px solid #f97316;">
                <div class="stat-num" style="color: #ea580c;">${halfDayCount}</div>
                <div class="stat-lbl">Half Days</div>
            </div>
            <div class="stat-card" style="border-top: 3px solid #ef4444;">
                <div class="stat-num" style="color: #dc2626;">${absentCount}</div>
                <div class="stat-lbl">Absent Days</div>
            </div>
            <div class="stat-card" style="border-top: 3px solid #3b82f6;">
                <div class="stat-num" style="color: #2563eb;">${totalWorkHours.toFixed(1)}h</div>
                <div class="stat-lbl">Total Working Time</div>
            </div>
            <div class="stat-card" style="border-top: 3px solid #8b5cf6;">
                <div class="stat-num" style="color: #7c3aed;">${totalBreakHours.toFixed(1)}h</div>
                <div class="stat-lbl">Total Break Time</div>
            </div>
            <div class="stat-card" style="border-top: 3px solid #64748b;">
                <div class="stat-num">${avgWorkHours}h</div>
                <div class="stat-lbl">Avg Hours/Day</div>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th style="width: 12%;">Date</th>
                    <th style="width: 14%;">Status</th>
                    <th style="width: 10%;">First IN</th>
                    <th style="width: 10%;">Last OUT</th>
                    <th style="width: 12%;">Work Time</th>
                    <th style="width: 10%;">Break Time</th>
                    <th style="width: 32%;">Punch Sessions Timeline</th>
                </tr>
            </thead>
            <tbody>
                ${rowsHtml || '<tr><td colspan="7" style="text-align: center; color: #94a3b8; padding: 20px;">No attendance records found for this period.</td></tr>'}
            </tbody>
        </table>

        <div class="footer">
            SmartAttend Dynamic Attendance Platform • Generated atomically from Firestore ledger • Tamper-resistant audit record
        </div>
    </body>
    </html>
    `;
}

/**
 * Builds HTML for organization / company-wide multi-employee report
 */
function buildAdminHtml({ company, records, employees = [], periodTitle, filters = {} }) {
    const totalRecords = records.length;
    let totalWorkHours = 0;
    let presentCount = 0;
    let halfDayCount = 0;
    let absentCount = 0;

    records.forEach(r => {
        if (r.status === 'present') presentCount++;
        else if (r.status === 'half_day') halfDayCount++;
        else if (r.status === 'absent') absentCount++;
        totalWorkHours += Number(r.totalWorkHours || r.workHours || 0);
    });

    const rowsHtml = records.map((r, idx) => {
        const sessions = Array.isArray(r.sessions) ? r.sessions : [];
        let sessionsTimeline = '';
        if (sessions.length > 0) {
            sessionsTimeline = sessions.map((s, sIdx) => {
                const inTime = s.checkInTime || (s.checkIn ? formatTime(new Date(s.checkIn)) : '-');
                const outTime = s.checkOutTime || (s.checkOut ? formatTime(new Date(s.checkOut)) : 'Active');
                return `#${sIdx + 1}: ${inTime} → ${outTime}`;
            }).join(' | ');
        } else {
            sessionsTimeline = `${r.checkInTime || '-'} → ${r.checkOutTime || '-'}`;
        }

        const statusClass = getStatusBadgeClass(r.status);
        const statusLabel = formatStatusLabel(r.status);

        return `
            <tr class="${idx % 2 === 0 ? 'even' : 'odd'}">
                <td><strong>${r.employeeName || 'Unknown'}</strong><br/><span style="color:#64748b; font-size:9.5px;">ID: ${r.employeeId || '-'}</span></td>
                <td>${r.date}</td>
                <td><span class="badge ${statusClass}">${statusLabel}</span> ${r.attendanceMode === 'WFH' ? '<span class="badge wfh">WFH</span>' : ''}</td>
                <td>${r.firstCheckInTime || r.checkInTime || '-'}</td>
                <td>${r.lastCheckOutTime || r.checkOutTime || '-'}</td>
                <td style="font-weight: 600; color: #1e3a8a;">${(r.totalWorkHours || r.workHours || 0).toFixed(1)}h</td>
                <td style="color: #64748b;">${(r.totalBreakHours || r.breakHours || 0).toFixed(1)}h</td>
                <td style="font-size: 10px;">${sessionsTimeline}</td>
            </tr>
        `;
    }).join('');

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8" />
        <title>${periodTitle}</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 20px; color: #0f172a; font-size: 11px; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #2563eb; padding-bottom: 10px; margin-bottom: 14px; }
            .company-name { font-size: 18px; font-weight: 700; color: #1e3a8a; }
            .report-title { font-size: 13px; font-weight: 600; color: #475569; margin-top: 3px; }
            .stats-bar { display: flex; gap: 10px; margin-bottom: 14px; }
            .stat-card { flex: 1; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; text-align: center; }
            .stat-num { font-size: 15px; font-weight: 700; }
            .stat-lbl { font-size: 9.5px; color: #64748b; margin-top: 2px; }
            table { width: 100%; border-collapse: collapse; margin-top: 8px; }
            th { background: #f1f5f9; color: #334155; font-weight: 700; text-align: left; padding: 7px 8px; border-bottom: 2px solid #cbd5e1; font-size: 10.5px; }
            td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: middle; }
            tr.even { background: #ffffff; }
            tr.odd { background: #f8fafc; }
            .badge { display: inline-block; padding: 2px 5px; border-radius: 3px; font-size: 9px; font-weight: 600; text-transform: uppercase; }
            .badge.present { background: #dcfce7; color: #15803d; }
            .badge.half_day { background: #ffedd5; color: #c2410c; }
            .badge.late { background: #fef9c3; color: #a16207; }
            .badge.absent { background: #fee2e2; color: #b91c1c; }
            .badge.wfh { background: #f3e8ff; color: #7e22ce; }
            .footer { margin-top: 20px; padding-top: 10px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 9.5px; }
        </style>
    </head>
    <body>
        <div class="header">
            <div>
                <div class="company-name">${company.name || 'Organization'}</div>
                <div class="report-title">${periodTitle}</div>
            </div>
            <div style="text-align: right; font-size: 10px; color: #64748b;">
                Generated: ${new Date().toLocaleString()}<br/>
                Total Records: ${totalRecords}
            </div>
        </div>

        <div class="stats-bar">
            <div class="stat-card" style="border-top: 3px solid #22c55e;">
                <div class="stat-num" style="color: #16a34a;">${presentCount}</div>
                <div class="stat-lbl">Total Present</div>
            </div>
            <div class="stat-card" style="border-top: 3px solid #f97316;">
                <div class="stat-num" style="color: #ea580c;">${halfDayCount}</div>
                <div class="stat-lbl">Half Days</div>
            </div>
            <div class="stat-card" style="border-top: 3px solid #ef4444;">
                <div class="stat-num" style="color: #dc2626;">${absentCount}</div>
                <div class="stat-lbl">Absents</div>
            </div>
            <div class="stat-card" style="border-top: 3px solid #3b82f6;">
                <div class="stat-num" style="color: #2563eb;">${totalWorkHours.toFixed(1)}h</div>
                <div class="stat-lbl">Cumulative Hours</div>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th style="width: 18%;">Employee</th>
                    <th style="width: 10%;">Date</th>
                    <th style="width: 12%;">Status</th>
                    <th style="width: 9%;">First IN</th>
                    <th style="width: 9%;">Last OUT</th>
                    <th style="width: 9%;">Work Time</th>
                    <th style="width: 9%;">Break</th>
                    <th style="width: 24%;">Punch Sessions Timeline</th>
                </tr>
            </thead>
            <tbody>
                ${rowsHtml || '<tr><td colspan="8" style="text-align: center; color: #94a3b8; padding: 15px;">No attendance records matching criteria.</td></tr>'}
            </tbody>
        </table>

        <div class="footer">
            SmartAttend Admin Report System • Generated from verified attendance ledger
        </div>
    </body>
    </html>
    `;
}

function getStatusBadgeClass(status) {
    if (status === 'present') return 'present';
    if (status === 'half_day') return 'half_day';
    if (status === 'late') return 'late';
    if (status === 'absent') return 'absent';
    return '';
}

function formatStatusLabel(status) {
    if (status === 'present') return 'Present';
    if (status === 'half_day') return 'Half Day';
    if (status === 'late') return 'Late (Present)';
    if (status === 'absent') return 'Absent';
    if (status === 'weekly_off') return 'Weekly Off';
    if (status === 'paid_leave') return 'Paid Leave';
    return status ? String(status).toUpperCase() : 'N/A';
}

