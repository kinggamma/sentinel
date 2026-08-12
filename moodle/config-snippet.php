<?php
/**
 * Server-side error capture for Moodle (PHP fatals, uncaught exceptions).
 *
 * Add this block near the bottom of config.php, before the final
 * `require_once(__DIR__ . '/lib/setup.php');` line. Requires the
 * Sentry PHP SDK:
 *
 *   composer require sentry/sentry
 *
 * (run inside your Moodle root, or vendor it in and adjust the
 * require path below if Composer isn't otherwise used in this install).
 */

require_once(__DIR__ . '/vendor/autoload.php');

\Sentry\init([
    'dsn' => getenv('GLITCHTIP_DSN_MOODLE'), // http://<key>@localhost:8000/<project-id> (or http://<server-ip>:8000/<project-id>)
    'environment' => getenv('MOODLE_ENV') ?: 'production',
    'release' => getenv('MOODLE_RELEASE') ?: null,
    'max_breadcrumbs' => 40,

    // Scrub PII before anything leaves the server. Moodle events routinely
    // carry emails/phone numbers in user objects and gradebook data —
    // strip aggressively rather than trying to allowlist fields.
    'before_send' => function (\Sentry\Event $event): ?\Sentry\Event {
        $request = $event->getRequest();
        if ($request !== null) {
            $data = $request['data'] ?? null;
            if (is_array($data)) {
                $data = moodle_incident_capture_scrub($data);
                $request['data'] = $data;
                $event->setRequest($request);
            }
        }
        return $event;
    },

    'before_breadcrumb' => function (\Sentry\Breadcrumb $breadcrumb): ?\Sentry\Breadcrumb {
        $data = $breadcrumb->getMetadata();
        if (is_array($data)) {
            $breadcrumb = $breadcrumb->withMetadata(
                $breadcrumb->getLevel(),
                $breadcrumb->getType(),
                $breadcrumb->getCategory(),
                $breadcrumb->getMessage(),
                moodle_incident_capture_scrub($data)
            );
        }
        return $breadcrumb;
    },
]);

// Tag every event consistently so it's filterable in GlitchTip alongside
// the other apps: app, moodle course id (never PII), moodle user id
// (opaque numeric id, not name/email).
global $USER, $COURSE;
\Sentry\configureScope(function (\Sentry\State\Scope $scope): void {
    global $USER, $COURSE;
    $scope->setTag('app', 'moodle-lms');
    if (!empty($COURSE->id)) {
        $scope->setTag('course_id', (string) $COURSE->id);
    }
    if (!empty($USER->id)) {
        $scope->setTag('user_id', (string) $USER->id); // numeric id only, not name/email
    }
});

function moodle_incident_capture_scrub(array $data): array {
    $piiKeys = ['email', 'phone', 'phone1', 'phone2', 'address', 'idnumber', 'password'];
    foreach ($data as $key => $value) {
        if (is_array($value)) {
            $data[$key] = moodle_incident_capture_scrub($value);
        } elseif (in_array(strtolower((string) $key), $piiKeys, true)) {
            $data[$key] = '[redacted]';
        } elseif (is_string($value)) {
            $data[$key] = preg_replace(
                '/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i',
                '[redacted]',
                $value
            );
        }
    }
    return $data;
}
