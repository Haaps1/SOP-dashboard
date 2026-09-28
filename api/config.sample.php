<?php
// Settings for the dashboard's PHP API. Save this file as api/config.php
// (it is not committed to git, and the website never shows it to visitors).
//
// Database: hPanel -> Databases -> Management. Create a database and a user,
// then copy the full names (with the u123456789_ prefix) and the password.
return [
    'db_host' => 'localhost',
    'db_port' => 3306,
    'db_name' => '',   // e.g. u123456789_sop
    'db_user' => '',   // e.g. u123456789_sop
    'db_pass' => '',
    'timezone' => 'Asia/Kolkata',

    // Step 1 of signing in: the password everyone types to open the dashboard.
    'site_password' => '',

    // The admin's own password (choose "Admin" on the sign-in screen).
    // Employee passwords are set by the admin inside the dashboard.
    'admin_password' => '',
];
