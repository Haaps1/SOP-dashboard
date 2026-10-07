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

    // The admin site (admin.haaps.co.in or /admin) asks for this username and
    // password. Employees sign in with their name and the password the admin
    // sets for them on the Team page.
    'admin_username' => 'admin',
    'admin_password' => '',
];
