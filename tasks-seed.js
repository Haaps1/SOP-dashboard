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
//     (in Daily Tasks on those days; one day = a weekly task due that day)
//   { title: "...", frequency: "monthly", due_day: 5 }  for a monthly task
window.SEED_VERSION = 3;

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
  Manju: [
    "SEO - MedFine",
    "SEO - HLC",
    "SEO - Mamtha",
    "SEO - Sanyra",
    "GMB - Dr Mangesh Kamath",
    "Google Ads - HLC",
    "Google Ads - Charu",
    { title: "ICE Social Media – poster creation + posting", days: ["Mon", "Wed", "Fri"] },
  ],
};
