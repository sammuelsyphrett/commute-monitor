const DESTINATION =
  "352 South 1230 West, Spanish Fork, UT 84660";

const TOMTOM_GEOCODE =
  "https://api.tomtom.com/search/2/geocode";

const TOMTOM_ROUTE =
  "https://api.tomtom.com/routing/1/calculateRoute";

/**
 * Secure Cloudflare Pages Function.
 *
 * TOMTOM_API_KEY must be configured as an
 * encrypted hosting secret.
 *
 * @param {{
 *   request: Request,
 *   env: {
 *     TOMTOM_API_KEY?: string
 *   }
 * }} context
 *
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  const key =
    context.env.TOMTOM_API_KEY;

  if (!key) {
    return json(
      {
        error:
          "SERVER_CONFIGURATION"
      },
      503
    );
  }

  let input;

  try {
    input =
      await context.request.json();
  } catch (error) {
    return json(
      {
        error:
          "INVALID_REQUEST"
      },
      400
    );
  }

  const lat =
    Number(input?.lat);

  const lon =
    Number(input?.lon);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return json(
      {
        error:
          "INVALID_LOCATION"
      },
      400
    );
  }

  try {
    const geocodeParameters =
      new URLSearchParams({
        key,
        limit: "1",
        typeahead: "false",
        countrySet: "US"
      });

    const geocodeUrl =
      `${TOMTOM_GEOCODE}/` +
      `${encodeURIComponent(DESTINATION)}.json?` +
      geocodeParameters.toString();

    const geocodeResponse =
      await fetch(
        geocodeUrl,
        {
          method: "GET",

          headers: {
            Accept:
              "application/json"
          }
        }
      );

    if (
      geocodeResponse.status === 401 ||
      geocodeResponse.status === 403
    ) {
      return json(
        {
          error:
            "TOMTOM_AUTH"
        },
        502
      );
    }

    if (
      geocodeResponse.status === 429
    ) {
      return json(
        {
          error:
            "RATE_LIMIT"
        },
        429
      );
    }

    if (!geocodeResponse.ok) {
      return json(
        {
          error:
            "TOMTOM_UNAVAILABLE"
        },
        502
      );
    }

    const geocodeData =
      await geocodeResponse.json();

    const destination =
      geocodeData &&
      Array.isArray(
        geocodeData.results
      ) &&
      geocodeData.results.length > 0
        ? geocodeData.results[0].position
        : null;

    if (
      !destination ||
      typeof destination.lat !== "number" ||
      typeof destination.lon !== "number"
    ) {
      return json(
        {
          error:
            "DESTINATION_NOT_FOUND"
        },
        502
      );
    }

    const routePoints =
      `${lat},${lon}:` +
      `${destination.lat},${destination.lon}`;

    const routeParameters =
      new URLSearchParams({
        key,
        traffic: "true",
        travelMode: "car",
        routeType: "fastest",
        computeTravelTimeFor: "all",
        departAt: "now",
        routeRepresentation:
          "summaryOnly"
      });

    const routeUrl =
      `${TOMTOM_ROUTE}/` +
      `${routePoints}/json?` +
      routeParameters.toString();

    const routeResponse =
      await fetch(
        routeUrl,
        {
          method: "GET",

          headers: {
            Accept:
              "application/json"
          }
        }
      );

    if (
      routeResponse.status === 401 ||
      routeResponse.status === 403
    ) {
      return json(
        {
          error:
            "TOMTOM_AUTH"
        },
        502
      );
    }

    if (
      routeResponse.status === 429
    ) {
      return json(
        {
          error:
            "RATE_LIMIT"
        },
        429
      );
    }

    if (!routeResponse.ok) {
      return json(
        {
          error:
            "TOMTOM_UNAVAILABLE"
        },
        502
      );
    }

    const routeData =
      await routeResponse.json();

    const summary =
      routeData &&
      Array.isArray(
        routeData.routes
      ) &&
      routeData.routes.length > 0
        ? routeData.routes[0].summary
        : null;

    if (!summary) {
      return json(
        {
          error:
            "NO_ROUTE"
        },
        404
      );
    }

    if (
      typeof summary.lengthInMeters !== "number" ||
      typeof summary.travelTimeInSeconds !== "number"
    ) {
      return json(
        {
          error:
            "INVALID_ROUTE_DATA"
        },
        502
      );
    }

    const trafficDelayInSeconds =
      typeof summary.trafficDelayInSeconds ===
      "number"
        ? summary.trafficDelayInSeconds
        : 0;

    const trafficLengthInMeters =
      typeof summary.trafficLengthInMeters ===
      "number"
        ? summary.trafficLengthInMeters
        : 0;

    const noTrafficTravelTimeInSeconds =
      typeof summary.noTrafficTravelTimeInSeconds ===
      "number"
        ? summary.noTrafficTravelTimeInSeconds
        : Math.max(
            0,
            summary.travelTimeInSeconds -
              trafficDelayInSeconds
          );

    return json({
      lengthInMeters:
        summary.lengthInMeters,

      travelTimeInSeconds:
        summary.travelTimeInSeconds,

      trafficDelayInSeconds,

      trafficLengthInMeters,

      noTrafficTravelTimeInSeconds
    });
  } catch (error) {
    return json(
      {
        error:
          "TOMTOM_UNAVAILABLE"
      },
      502
    );
  }
}

/**
 * Returns a secured JSON response.
 *
 * @param {unknown} body
 * @param {number=} status
 * @returns {Response}
 */
function json(
  body,
  status = 200
) {
  return new Response(
    JSON.stringify(body),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store",

        "X-Content-Type-Options":
          "nosniff",

        "Referrer-Policy":
          "no-referrer"
      }
    }
  );
}
