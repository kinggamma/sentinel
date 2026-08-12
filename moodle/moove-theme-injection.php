<?php
/**
 * Client-side (JS) incident capture injection for the Moove child theme.
 *
 * Add to your Moove child theme's lib.php:
 *
 *   function theme_yourchildtheme_before_standard_html_head() { ... }
 *
 * or, if you'd rather not touch PHP, paste the equivalent into
 * Site administration > Appearance > Additional HTML > "Within HEAD".
 * The PHP route below is preferred because it can check capability
 * server-side before ever rendering the config into the page.
 */

function theme_yourchildtheme_before_standard_html_head() {
    global $USER, $PAGE, $COURSE;

    // Staff gating: only render (and therefore only load) incident capture
    // for users who can grade/manage — i.e. staff/admin, never students.
    $context = $PAGE->context ?? \context_system::instance();
    if (!has_capability('moodle/grade:manage', $context)) {
        return '';
    }

    // Never inject on pages that are gradebook or profile pages — belt
    // and suspenders on top of the client-side excludedPaths check,
    // since those pages carry grades/PII directly in the DOM.
    $excludedPages = ['grade-report', 'user-profile', 'user-editadvanced'];
    if (in_array($PAGE->pagetype, $excludedPages, true)) {
        return '';
    }

    $config = [
        'dsn' => get_config('theme_yourchildtheme', 'glitchtip_dsn_js'),
        'receiverUrl' => get_config('theme_yourchildtheme', 'feedback_receiver_url'),
        'staffToken' => get_config('theme_yourchildtheme', 'feedback_staff_token'),
        'appName' => 'moodle-lms',
        'userEmail' => $USER->email ?? null,
        'environment' => 'production',
        'extraTags' => [
            'course_id' => $COURSE->id ?? null,
        ],
    ];

    $json = json_encode($config, JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_HEX_AMP);

    return "
        <script>window.__INCIDENT_CAPTURE_CONFIG__ = {$json};</script>
        <script type=\"module\" src=\"/theme/yourchildtheme/javascript/incident-capture-init.js\"></script>
    ";
}
