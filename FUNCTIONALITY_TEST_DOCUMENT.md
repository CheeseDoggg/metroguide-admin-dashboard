# Functionality Test Document

This document records 5 test cycles for each module: LOGIN, HOME, and ADMIN.

## LOGIN Module

| Cycle | Test Case | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| 1 | Successful login | Enter valid admin credentials, click Login | Redirects to Admin Dashboard | As expected | PASS |
| 2 | Invalid password | Enter valid email, wrong password | Error message shown, no redirect | As expected | PASS |
| 3 | Empty fields | Leave email/password empty, click Login | Validation prevents submit | As expected | PASS |
| 4 | Session persistence | Login, refresh page | Remains logged in and shows dashboard | As expected | PASS |
| 5 | Logout | Click Logout | Redirects to login page | As expected | PASS |

## HOME Module (Incident Reports)

| Cycle | Test Case | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| 1 | Load incidents | Open Incident Reports tab | Table lists recent incidents | As expected | PASS |
| 2 | Filter/search | Use search and category filter | Table shows matching incidents | As expected | PASS |
| 3 | Verify action | Click Verify on a pending report | Status changes to Verified | As expected | PASS |
| 4 | Reject action | Click Reject on a pending report | Status changes to Rejected | As expected | PASS |
| 5 | Image modal | Click thumbnail image | Full image shows in modal | As expected | PASS |

## ADMIN Module (History, Vehicle, SOS)

| Cycle | Test Case | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| 1 | History view | Open History tab | Verified/Rejected reports listed | As expected | PASS |
| 2 | History export | Click Print/PDF and CSV | Files generated with filtered data | As expected | PASS |
| 3 | Vehicle export | Open Vehicle tab, export PDF/CSV | Files generated with filtered data | As expected | PASS |
| 4 | SOS map view | Open SOS, click View on a row | Map modal opens at coordinates | As expected | PASS |
| 5 | SOS export | Export PDF/CSV in SOS tab | Files generated with filters | As expected | PASS |

Notes:
- All tests executed against the Firebase-hosted app and Realtime Database.
- Exports use jsPDF and AutoTable; images optional depending on checkbox.
- SOS View button uses Google Maps JS API; geometry library loaded.
