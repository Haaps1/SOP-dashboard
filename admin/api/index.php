<?php
// Admin entrance (admin.haaps.co.in or haaps.co.in/admin): the same API and
// database as the team site, but only the admin password signs in here, and
// it uses its own sign-in cookie.
define('SOP_ADMIN_ENTRY', true);
require __DIR__ . '/../../api/index.php';
