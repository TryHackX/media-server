<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use RuntimeException;

class BridgeException extends RuntimeException
{
}

final class BridgeAuthenticationException extends BridgeException
{
}

final class BridgeAuthorizationException extends BridgeException
{
}

final class BridgeRequestException extends BridgeException
{
}

final class CatalogItemNotFoundException extends BridgeException
{
}

final class BridgeRateLimitException extends BridgeException
{
    /**
     * @param int $retryAfter seconds the caller should wait, 0 when unknown (sent as Retry-After)
     * @param string $reason what stopped it, for the log: "paused" or "blocked" (StepUpGuard), else empty
     */
    public function __construct(string $message = '', public readonly int $retryAfter = 0, public readonly string $reason = '')
    {
        parent::__construct($message);
    }
}

/**
 * Something this request needs is not answering right now (a captcha provider,
 * the indexing service). Nothing is wrong with the request and nothing is wrong
 * with the bridge: 503 with the message, not "internal error".
 */
final class BridgeUnavailableException extends BridgeException
{
}

/**
 * The request may go on once a person proves to be there (StepUpGuard, the
 * sign-in forms). Carries what the page needs to show the challenge: the
 * provider, its public key and the action name a v3 token must carry.
 */
final class BridgeCaptchaRequiredException extends BridgeException
{
    /** @param array{provider:string,site_key:string,action?:string} $challenge */
    public function __construct(string $message, public readonly array $challenge)
    {
        parent::__construct($message);
    }
}

