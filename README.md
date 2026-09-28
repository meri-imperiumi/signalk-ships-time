# Ship's Time for Signal K

This plugin publishes the vessel's timezone so every clock and display aboard can render ship's local time. It is the **offset source only**: UTC time itself stays the domain of GNSS via `navigation.datetime`, and this plugin never publishes time values.

* `environment.time.timezoneOffset`: onboard timezone offset from UTC in `(-)hhmm` encoding (e.g. `200`, `-930`), as defined by the Signal K `environment.json` schema. Per the spec, all clocks aboard displaying local time should use this.
* `environment.time.timezoneRegion`: IANA timezone region (e.g. `Pacific/Marquesas`) when known. UIs should display it in preference to the plain offset.

## Modes

* **manual**: the crew configures a UTC offset in decimal hours (and optionally an IANA region) and updates it when crossing timezones.
* **auto**: the IANA timezone is derived from the vessel's position, and the offset (DST included) is computed from it. Timezone changes are rare, so recomputes and the position updates requested from the server are both throttled to once every 10 minutes by default (configurable). The delta is republished only when the timezone actually changes.

## Timezone lookup library decision

Auto mode needs a position → timezone lookup. We evaluated the two main candidates:

| | tz-lookup (in use) | geo-tz |
|---|---|---|
| Install size | 172K | 71MB |
| Data freshness | last updated 2019 | current |
| Land/coastal accuracy | simplified | exact (territorial waters only) |
| High-seas behavior | no principled ocean model; can attribute land zones to open ocean with occasional artifacts (e.g. `Pacific/Kiritimati` returned at 0°N 150°W where the correct band is `Etc/GMT+10`) | strict: `Etc/GMT±X` ocean bands outside territorial waters |
| License | CC0-1.0 | MIT code, ODbL-derived data |

**Decision:** we ship with `tz-lookup` for its tiny footprint and CC0 license, accepting the high-seas quirks. In practice a ship's clock following the nearest-land zone is usually what the crew wants anyway (you're already on destination time when you make landfall). The lookup is injected behind a small interface, so switching to `geo-tz` — the semantically stricter choice at sea — is a contained change if the artifacts become a problem.
