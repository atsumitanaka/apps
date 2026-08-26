# NIMS Junior Work Schedule Generator

A web tool for building yearly work-day schedules for NIMS Junior researchers (Master / Doctor programs). The office (admin) creates schedules for multiple students and distributes them via share links or email.

**Live URLs**

| Page | URL |
|---|---|
| Admin (JP) | https://atsumitanaka.github.io/apps/nims_junior_schedule/admin/ |
| Admin (EN) | https://atsumitanaka.github.io/apps/nims_junior_schedule/admin/index_en.html |
| Student view (JP) | https://atsumitanaka.github.io/apps/nims_junior_schedule/#s=… |
| Student view (EN) | https://atsumitanaka.github.io/apps/nims_junior_schedule/index_en.html#s=… |

Student view URLs are generated from the admin page.

---

## Overview

- **Programs:** Master (11 days/month, 132/year), Doctor (14 days/month, 168/year)
- **Core rule:** *Exactly 3 work days in any 7 consecutive days*
- **Adjustment months:** February, March, August, September plus 7-day buffers before/after (rule exempt)
- **Summer leave:** NIMS-recommended Obon period (4 weekdays around Aug 13–16, excluding weekends and holidays) is auto-marked off

---

## For administrators (office)

### 1. Register a student

1. Open the admin page (`/admin/index_en.html`).
2. Click **"+ Add student"** to create a new tab.
3. Enter the student's **Name** and **Email**.
4. Set the **Program** (Master / Doctor), **Start month**, and **Weekly pattern** (select up to 3 work days).
5. The calendar is generated automatically.

You can manage multiple students simultaneously and switch between them using the tabs.

### 2. Adjust the calendar

- **Click any date** to toggle between "Work day (blue)" and "Off day (white)".
- **Light-yellow days** (adjustment months + buffers) are exempt from the 3-day rule and can be set freely.
- **Light-purple days** (summer leave / Obon) are set automatically.
- A **`!` mark** indicates a 3-day/week rule violation — check the red-bordered week and adjust.
- **"Reset edits"** removes all manual overrides (weekly pattern is unaffected).

### 3. Share the schedule

- **"Send email"**: Opens your email client with the recipient, subject, and share URL pre-filled (you send it manually).
- **"Copy link"**: Copies the URL to your clipboard for pasting into chat, Teams, etc.

After updating a schedule, send the student a new link.

### 4. Export CSV

Click **"Export CSV"** to download the full-year work data (date, weekday, work flag, adjustment flag, holiday name) as an Excel/Numbers-compatible CSV file.

---

## For students

1. Open the URL sent by the NIMS Junior office on any PC or smartphone.
2. Your calendar, weekly pattern, and monthly totals appear.
3. Use **"Export CSV"** to save the data locally.
4. Editing is disabled. If updates are needed, contact the office and ask them to re-send a new link.

---

## Color reference

| Display | Meaning |
|---|---|
| Blue | Work day |
| Light yellow | Adjustment period (3-day rule exempt, freely editable) |
| Light purple | Summer leave / Obon (auto-set) |
| White | Off day |
| Red border + `!` | 3-day/week rule violation |

- Weeks containing public holidays or Obon days are exempt from violation checks
- Adjustment months (Feb, Mar, Aug, Sep) and their 7-day buffers are also exempt

---

## Data storage & limits

| Item | Details |
|---|---|
| Storage location | Browser localStorage (nothing sent to a server) |
| Max students | No hard limit — practical limit is browser storage capacity (typically 5–10 MB) |
| Capacity estimate | Tens to over 100 students can be stored without issue |
| Data backup | Use "Copy link" to save each student's share URL before clearing browser data or switching PCs |

> **Note:** Data is lost if you clear the browser cache, end a private-browsing session, or switch browsers. Always keep a backup of each student's share URL.

---

## Technical notes

- **Single HTML files × 4** (admin JP/EN, student JP/EN) — no build step, no external dependencies
- **State:** admin uses `localStorage` (`nims_junior_admin_v1`); student view is stateless and reads from URL fragment `#s=<base64(JSON)>`
- **Email sending:** uses `mailto:` to open the admin's default mail client (Outlook / Apple Mail / Gmail)
- **Holidays:** approximation formulas valid for 1980–2099 (includes equinoxes, substitute holidays, and "national holidays" between two public holidays)
- **Obon / summer leave:** 4 weekdays around Aug 13–16, automatically excluding weekends and public holidays
