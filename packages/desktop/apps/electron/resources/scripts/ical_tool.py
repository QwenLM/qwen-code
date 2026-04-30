# /// script
# requires-python = ">=3.12"
# dependencies = ["icalendar>=7.0,<8", "click>=8.3,<9", "python-dateutil>=2.9,<3"]
# ///
"""Calendar (.ics) file operations tool.

Commands: read, create, filter.

Usage:
    uv run ical_tool.py COMMAND [OPTIONS]
"""

import json
import re
import sys
from datetime import datetime, date, timedelta, timezone
from pathlib import Path

import click
from dateutil.parser import parse as parse_date
from dateutil.tz import tzlocal
from icalendar import Calendar, Event


def _is_date_only(date_str: str) -> bool:
    """Check if a date string represents a date-only value (no time component).

    Returns True for "2024-03-15", False for "2024-03-15T00:00:00" or "2024-03-15 00:00:00".
    """
    return "T" not in date_str and not re.search(r"\s\d{1,2}:", date_str)


def write_output(text: str, output_path: str | None) -> None:
    """Write text to file or stdout."""
    if output_path:
        Path(output_path).write_text(text, encoding="utf-8")
        click.echo(f"Output written to {output_path}", err=True)
    else:
        click.echo(text)


def dt_to_datetime(dt_val) -> datetime | None:
    """Convert an icalendar date/datetime to a Python datetime.

    All-day events (date objects) are converted to midnight in the local timezone,
    so that filtering by date range works correctly regardless of the user's timezone.
    """
    if dt_val is None:
        return None
    dt = dt_val.dt if hasattr(dt_val, "dt") else dt_val
    if isinstance(dt, datetime):
        return dt
    elif isinstance(dt, date):
        return datetime(dt.year, dt.month, dt.day, tzinfo=tzlocal())
    return None


def format_event(event, idx: int | None = None) -> dict[str, object]:
    """Format a VEVENT component as a dictionary."""
    result: dict[str, object] = {}
    if idx is not None:
        result["index"] = idx

    result["summary"] = str(event.get("SUMMARY", ""))

    dtstart = event.get("DTSTART")
    dtend = event.get("DTEND")
    if dtstart:
        start_dt = dt_to_datetime(dtstart)
        result["start"] = start_dt.isoformat() if start_dt else str(dtstart.dt)
    if dtend:
        end_dt = dt_to_datetime(dtend)
        result["end"] = end_dt.isoformat() if end_dt else str(dtend.dt)

    duration = event.get("DURATION")
    if duration and not dtend:
        result["duration"] = str(duration.dt)

    location = event.get("LOCATION")
    if location:
        result["location"] = str(location)

    description = event.get("DESCRIPTION")
    if description:
        result["description"] = str(description)

    status = event.get("STATUS")
    if status:
        result["status"] = str(status)

    organizer = event.get("ORGANIZER")
    if organizer:
        result["organizer"] = str(organizer)

    attendees = event.get("ATTENDEE")
    if attendees:
        if isinstance(attendees, list):
            result["attendees"] = [str(a) for a in attendees]
        else:
            result["attendees"] = [str(attendees)]

    rrule = event.get("RRULE")
    if rrule:
        result["recurrence"] = str(rrule.to_ical().decode("utf-8"))

    uid = event.get("UID")
    if uid:
        result["uid"] = str(uid)

    return result


@click.group()
def cli() -> None:
    """Calendar (.ics) file operations tool."""
    pass


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--format", "fmt", type=click.Choice(["json", "text"]), default="text", help="Output format (default: text).")
@click.option("-o", "--output", type=click.Path(), default=None, help="Write output to file.")
def read(file: str, fmt: str, output: str | None) -> None:
    """Read and display events from an .ics calendar file."""
    try:
        cal_text = Path(file).read_bytes()
        cal = Calendar.from_ical(cal_text)

        # Calendar metadata
        cal_name = str(cal.get("X-WR-CALNAME", cal.get("PRODID", "Unknown")))

        events = []
        event_idx = 0
        for component in cal.walk():
            if component.name == "VEVENT":
                event_idx += 1
                events.append(format_event(component, event_idx))

        if fmt == "json":
            result_dict = {
                "file": str(Path(file).resolve()),
                "calendar_name": cal_name,
                "event_count": len(events),
                "events": events,
            }
            write_output(json.dumps(result_dict, indent=2, default=str), output)
        else:
            lines = [f"Calendar: {cal_name}", f"Events: {len(events)}", ""]
            for ev in events:
                lines.append(f"[{ev.get('index', '')}] {ev.get('summary', 'Untitled')}")
                if "start" in ev:
                    lines.append(f"    Start: {ev['start']}")
                if "end" in ev:
                    lines.append(f"    End:   {ev['end']}")
                if "location" in ev:
                    lines.append(f"    Location: {ev['location']}")
                if "description" in ev:
                    desc = str(ev["description"])
                    if len(desc) > 100:
                        desc = desc[:100] + "..."
                    lines.append(f"    Description: {desc}")
                if "recurrence" in ev:
                    lines.append(f"    Recurrence: {ev['recurrence']}")
                lines.append("")
            write_output("\n".join(lines), output)

    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.option("--data", type=str, required=True, help="JSON string or path to JSON file defining events.")
@click.option("--cal-name", type=str, default="My Calendar", help="Calendar name.")
@click.option("-o", "--output", type=click.Path(), default=None, help="Output .ics file path (or stdout).")
def create(data: str, cal_name: str, output: str | None) -> None:
    """Create an .ics calendar file from JSON event data.

    JSON format (array of events):
    [
      {
        "summary": "Meeting",
        "start": "2024-03-15T10:00:00",
        "end": "2024-03-15T11:00:00",
        "location": "Room 101",
        "description": "Weekly standup",
        "attendees": ["alice@example.com"]
      }
    ]

    Date formats: ISO 8601 (e.g. "2024-03-15T10:00:00", "2024-03-15").
    All-day events: use date-only strings for start/end.
    """
    try:
        # Parse data
        data_path = Path(data)
        if data_path.exists() and data_path.is_file():
            events_data = json.loads(data_path.read_text(encoding="utf-8"))
        else:
            events_data = json.loads(data)

        if not isinstance(events_data, list):
            click.echo("Error: JSON must be an array of event objects.", err=True)
            sys.exit(1)

        cal = Calendar()
        cal.add("PRODID", "-//ical_tool.py//EN")
        cal.add("VERSION", "2.0")
        cal.add("X-WR-CALNAME", cal_name)

        for i, ev_data in enumerate(events_data):
            event = Event()

            summary = ev_data.get("summary", f"Event {i + 1}")
            event.add("SUMMARY", summary)

            # Start time
            start_str = ev_data.get("start")
            if start_str:
                start_dt = parse_date(start_str)
                if _is_date_only(start_str):
                    event.add("DTSTART", start_dt.date())
                else:
                    if start_dt.tzinfo is None:
                        start_dt = start_dt.replace(tzinfo=tzlocal())
                    event.add("DTSTART", start_dt)

            # End time
            end_str = ev_data.get("end")
            if end_str:
                end_dt = parse_date(end_str)
                if _is_date_only(end_str):
                    event.add("DTEND", end_dt.date())
                else:
                    if end_dt.tzinfo is None:
                        end_dt = end_dt.replace(tzinfo=tzlocal())
                    event.add("DTEND", end_dt)
            elif start_str and _is_date_only(start_str):
                # All-day event without end: make it 1 day
                start_dt = parse_date(start_str)
                event.add("DTEND", start_dt.date() + timedelta(days=1))

            # Optional fields
            if "location" in ev_data:
                event.add("LOCATION", ev_data["location"])
            if "description" in ev_data:
                event.add("DESCRIPTION", ev_data["description"])
            if "status" in ev_data:
                event.add("STATUS", ev_data["status"].upper())

            # Attendees
            attendees = ev_data.get("attendees", [])
            for attendee in attendees:
                if not attendee.startswith("mailto:"):
                    attendee = f"mailto:{attendee}"
                event.add("ATTENDEE", attendee)

            # UID
            uid = ev_data.get("uid", f"event-{i + 1}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}@ical-tool")
            event.add("UID", uid)
            event.add("DTSTAMP", datetime.now(timezone.utc))

            cal.add_component(event)

        ics_bytes = cal.to_ical()
        if output:
            Path(output).write_bytes(ics_bytes)
            click.echo(f"Output written to {output}", err=True)
        else:
            click.echo(ics_bytes.decode("utf-8"))

    except json.JSONDecodeError as e:
        click.echo(f"Error parsing JSON: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--start", "start_str", type=str, required=True, help="Filter start date (ISO 8601, e.g. '2024-01-01').")
@click.option("--end", "end_str", type=str, required=True, help="Filter end date (ISO 8601, e.g. '2024-12-31').")
@click.option("--format", "fmt", type=click.Choice(["json", "text", "ics"]), default="text", help="Output format (default: text).")
@click.option("-o", "--output", type=click.Path(), default=None, help="Write output to file.")
def filter(file: str, start_str: str, end_str: str, fmt: str, output: str | None) -> None:
    """Filter events within a date range.

    Returns events whose start time falls within the specified range.
    """
    try:
        filter_start = parse_date(start_str)
        filter_end = parse_date(end_str)

        # Make timezone-aware if needed (use local timezone, consistent with create command)
        if filter_start.tzinfo is None:
            filter_start = filter_start.replace(tzinfo=tzlocal())
        if filter_end.tzinfo is None:
            filter_end = filter_end.replace(tzinfo=tzlocal())

        cal_text = Path(file).read_bytes()
        cal = Calendar.from_ical(cal_text)

        matching_events = []
        matching_components = []

        for component in cal.walk():
            if component.name != "VEVENT":
                continue

            dtstart = component.get("DTSTART")
            if dtstart is None:
                continue

            event_start = dt_to_datetime(dtstart)
            if event_start is None:
                continue

            # Make timezone-aware if needed (use local timezone, consistent with filter boundaries)
            if event_start.tzinfo is None:
                event_start = event_start.replace(tzinfo=tzlocal())

            if filter_start <= event_start <= filter_end:
                matching_events.append(format_event(component, len(matching_events) + 1))
                matching_components.append(component)

        if fmt == "ics":
            # Output as new .ics
            new_cal = Calendar()
            new_cal.add("PRODID", "-//ical_tool.py//EN")
            new_cal.add("VERSION", "2.0")
            # Copy timezone definitions from source calendar
            for comp in cal.walk():
                if comp.name == "VTIMEZONE":
                    new_cal.add_component(comp)
            for comp in matching_components:
                new_cal.add_component(comp)
            write_output(new_cal.to_ical().decode("utf-8"), output)

        elif fmt == "json":
            result_dict = {
                "file": str(Path(file).resolve()),
                "filter_start": filter_start.isoformat(),
                "filter_end": filter_end.isoformat(),
                "event_count": len(matching_events),
                "events": matching_events,
            }
            write_output(json.dumps(result_dict, indent=2, default=str), output)

        else:
            lines = [
                f"Events from {filter_start.date()} to {filter_end.date()}: {len(matching_events)}",
                "",
            ]
            for ev in matching_events:
                lines.append(f"[{ev.get('index', '')}] {ev.get('summary', 'Untitled')}")
                if "start" in ev:
                    lines.append(f"    Start: {ev['start']}")
                if "end" in ev:
                    lines.append(f"    End:   {ev['end']}")
                if "location" in ev:
                    lines.append(f"    Location: {ev['location']}")
                lines.append("")
            write_output("\n".join(lines), output)

    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


if __name__ == "__main__":
    cli()
