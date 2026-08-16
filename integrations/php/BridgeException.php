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
}

