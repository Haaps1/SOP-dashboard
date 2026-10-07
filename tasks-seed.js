// Default task list for each employee.
//
// SEED_VERSION: bump this number whenever you edit the list below. The next
// time the admin signs in, the database is brought in line with this list:
// new tasks are added, tasks removed from here are deleted, and tasks whose
// person + title are unchanged keep their history. Tasks added from the
// dashboard itself are never touched.
//
// Each entry is a task title (a daily task), or
//   { title: "...", days: ["Mon", "Wed", "Fri"] }  for a task on set weekdays
//   { title: "...", frequency: "weekdays", due_day: 2 }  for one set weekday that
//     still shows in Daily Tasks (bitmask: Mon 1, Tue 2, Wed 4, Thu 8, Fri 16)
//     (in Daily Tasks on those days; one day = a weekly task due that day)
//   { title: "...", dates: [5, 20] }  for a task on set dates of the month
//     (in Daily Tasks on those dates; a Saturday moves to Friday and a Sunday
//     to Monday)
//   { title: "...", frequency: "monthly", due_day: 5 }  for a monthly task
//   { title: "...", frequency: "monthstart", due_day: 6 }  for work done over
//     the first 6 Monday-Friday days of the month (each Sat/Sun adds a day).
//     It is in Daily Tasks on each of those days and keeps one record for the
//     month (Start, Pause, Finish), and goes to Pending if not finished by then.
window.SEED_VERSION = 10;

window.EMPLOYEES = ["Anil", "Madhu", "Manju", "Harsha", "Manju Designer"];

// Work days for daily tasks (0 = Sunday, 1 = Monday ... 6 = Saturday).
// A daily task not finished on one of these days shows as Pending the next day.
window.WORK_DAYS = [1, 2, 3, 4, 5, 6];

// Employees who get a "done" counter under the date, and what to call the
// items being counted.
window.DONE_COUNTERS = {
  "Manju Designer": "videos",
};

window.SEED_TASKS = {
  Anil: [
    "Client SEO – HAAPS",
    "Client Ads – HAAPS",
    "Client Ads – KVA",
    "Client Ads – Commet",
    "Social media posting – UBM",
    "Social media (content + client SM) – HAAPS.AI, HAAPS.Digital",
    { title: "GMB – HAAPS: posts + listing", days: ["Mon", "Wed", "Fri"] },
    { title: "Website updates (plugin, theme, WordPress) + web backup – HAAPS.AI, HAAPS.Digital", frequency: "weekdays", due_day: 2 },
    { title: "Poster creation – UBM", frequency: "weekdays", due_day: 16 },
    { title: "Full website updates + backup – HAAPS.AI, HAAPS.Digital", frequency: "monthstart", due_day: 5 },
    { title: "Blogs – HAAPS", frequency: "monthstart", due_day: 5 },
    { title: "SEO & SMM report – UBM", frequency: "monthstart", due_day: 5 },
    { title: "SEO & SMM report – HAAPS", frequency: "monthstart", due_day: 5 },
  ],
  Madhu: [
    "Meta Ads - HLC",
    "SEO - Dr. Varun Kumar J",
    "SEO - KVA",
    "SEO - Dr. Neema Bhat",
    "GMB - Dr. Neema Bhat",
    "Video Posting + thumbnails",
    "Morning Social Media Posting",
    // Every Tuesday: in Daily Tasks that day.
    { title: "Website Malware", frequency: "weekdays", due_day: 2 },
    { title: "Website Analytics + Console", frequency: "weekdays", due_day: 2 },
    { title: "Blogs – 6 blogs (Sanyra, Dr. Varun Kumar J)", frequency: "monthstart", due_day: 5 },
    { title: "SM Calendar", frequency: "monthstart", due_day: 5 },
    { title: "Reports", frequency: "monthstart", due_day: 5 },
  ],
  Manju: [
    "SEO - MedFine",
    "SEO - HLC",
    "SEO - Mamtha",
    "SEO - Sanyra",
    "GMB - Dr Mangesh Kamath",
    "GMB - Neema Bhat",
    "Google Ads - HLC",
    "Google Ads - Charu",
    { title: "ICE Social Media – poster creation + posting", days: ["Mon", "Wed", "Fri"] },
    { title: "GMB - MedFine", dates: [5, 20] },
    { title: "GMB - Dr Sri Kamath", dates: [5, 20] },
    { title: "GMB - HLC", dates: [5, 20] },
    { title: "GMB - Sanyra", dates: [5, 20] },
    { title: "Posters creation – All clients", frequency: "monthstart", due_day: 6 },
    { title: "Reports – MedFine, HLC, Mamtha, Sanyra", frequency: "monthstart", due_day: 6 },
    { title: "Blogs – 14 blogs (KVA, HLC, Mamtha, Sanyra)", frequency: "monthstart", due_day: 6 },
  ],
};
