# NIMS Junior Work Schedule Generator

A web-based tool to build the yearly work-day schedule for NIMS Junior researchers (Master / Doctor programs). Runs entirely in the browser; single HTML file; no backend.

**Live URL:** https://atsumitanaka.github.io/apps/nims_kinmu/index_en.html

## Overview

- **Programs:** Master (11 days/mo, 132 days/yr), Doctor (14 days/mo, 168 days/yr)
- **Core rule:** *Exactly 3 work days in any 7 consecutive days*
  - Mathematically this reduces to picking a fixed weekly pattern of 3 weekdays
- **Adjustment months:** February, March, August, September, plus 7 days before/after each — the 3-day/week rule does not apply during these buffer periods (to absorb Golden Week, Obon, New Year, and fiscal-year transitions)
- **Summer leave:** NIMS-recommended Obon period — 4 weekdays centered on Aug 13–16, excluding weekends and public holidays — is automatically marked off

## Usage

1. Choose **Program** (Master / Doctor)
2. Choose **Start** year/month (default April)
3. Choose **Weekly pattern** — pick 3 weekdays (default Mon/Wed/Fri)
4. Click any day in the calendar to toggle work/off
5. Check the annual summary at the top to see how you compare to the target
6. Use **Export CSV** to download an Excel/Numbers-compatible CSV

## Color legend

| Color | Meaning |
|---|---|
| Blue | Work day |
| Light yellow | Adjustment period (freely editable) |
| Light purple | Summer leave (Obon) |
| White | Off day |
| Red border + `!` | 3-day/week rule violation (weeks containing holidays or summer leave are exempt) |

## Technical notes

- Single HTML file, no build step, no dependencies
- State auto-saved via localStorage
- Japanese public holidays computed via approximation formulas valid for 1980–2099 (includes equinoxes and substitute holidays)
