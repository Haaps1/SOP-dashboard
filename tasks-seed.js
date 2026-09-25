// Default task list for each employee.
//
// SEED_VERSION: bump this number whenever you edit the list below. On the next
// page load the database is rewritten to match this list, instead of staying
// stuck on the old saved tasks. Tasks whose employee + title are unchanged keep
// their start/end times; renamed or removed tasks are replaced.
window.SEED_VERSION = 1;

window.EMPLOYEES = ["Anil", "Madhu", "Manju", "Harsha"];

window.SEED_TASKS = {
  Anil: [
    "SMM - HAAPS.AI / HAAPS.Digital",
    "Website Updates",
    "SM Content",
    "SEO - HAAPS",
    "SM - UBM",
    "Ads - HAAPS, KVA",
    "GMB - HAAPS",
    "Reports - UBM",
  ],
  Madhu: [
    "Website Audit (Weekly)",
    "Website Console & Analytics (Weekly)",
    "Website Error Fixing",
    "SMM - HLC, Medfine",
    "SM Content - HAAPS.AI",
    "SEO - Sanyra, KVA",
    "SM - Sanyra, KVA",
    "Ads - HLC",
    "GMB - Medfine, KVA",
    "Reports",
    "Blogs",
    "Poster Creation",
  ],
  Manju: [
    "SM Content - HAAPS.Digital",
    "SEO - Medfine, HLC, Mamtha",
    "SM - ICE, Medfine, Mamtha",
    "Ads - HLC, Commet, Charu",
    "GMB - HLC, Sanyra",
    "Reports",
    "Blogs - HAAPS, KVA",
    "Poster Creation",
  ],
  Harsha: [
    "SMM - 3FS",
    "Doctors Podcast",
    "Editing Client's Reels",
    "Promotional Reels",
    "Insta Reels Content",
    "AI Reels",
  ],
};
