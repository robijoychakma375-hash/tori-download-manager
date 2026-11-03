use std::str::FromStr;
use url::Url;

use crate::error::{EngineError, Result};

/// Root MPEG-DASH MPD Manifest data model (ISO/IEC 23009-1).
#[derive(Debug, Clone, PartialEq)]
pub struct DashManifest {
    pub is_dynamic: bool,
    pub media_presentation_duration: Option<f64>,
    pub min_buffer_time: Option<f64>,
    pub base_urls: Vec<String>,
    pub periods: Vec<DashPeriod>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashPeriod {
    pub id: Option<String>,
    pub start: Option<f64>,
    pub duration: Option<f64>,
    pub base_urls: Vec<String>,
    pub adaptation_sets: Vec<DashAdaptationSet>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashAdaptationSet {
    pub id: Option<String>,
    pub content_type: Option<String>,
    pub mime_type: Option<String>,
    pub codecs: Option<String>,
    pub lang: Option<String>,
    pub base_urls: Vec<String>,
    pub segment_template: Option<DashSegmentTemplate>,
    pub content_protection: Vec<DashContentProtection>,
    pub representations: Vec<DashRepresentation>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashContentProtection {
    pub scheme_id_uri: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashRepresentation {
    pub id: String,
    pub bandwidth: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub codecs: Option<String>,
    pub mime_type: Option<String>,
    pub base_urls: Vec<String>,
    pub segment_template: Option<DashSegmentTemplate>,
    pub segment_list: Option<DashSegmentList>,
    pub segment_base: Option<DashSegmentBase>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashSegmentTemplate {
    pub timescale: u64,
    pub duration: Option<u64>,
    pub initialization: Option<String>,
    pub media: Option<String>,
    pub start_number: u64,
    pub presentation_time_offset: u64,
    pub timeline: Option<Vec<DashTimelineEntry>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DashTimelineEntry {
    pub t: Option<u64>,
    pub d: u64,
    pub r: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashSegmentList {
    pub timescale: u64,
    pub initialization: Option<DashInitialization>,
    pub segment_urls: Vec<DashSegmentUrl>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashSegmentBase {
    pub timescale: u64,
    pub initialization: Option<DashInitialization>,
    pub index_range: Option<(u64, u64)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashInitialization {
    pub source_url: Option<String>,
    pub range: Option<(u64, u64)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashSegmentUrl {
    pub media: Option<String>,
    pub media_range: Option<(u64, u64)>,
}

/// A resolved downloadable segment with absolute URI and optional byte range.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedDashSegment {
    pub uri: String,
    pub byterange: Option<(u64, u64)>, // (start, end)
    pub duration_seconds: f64,
    pub sequence_number: u64,
}

/// Resolved representation bundle with initialization segment and media segments.
#[derive(Debug, Clone, PartialEq)]
pub struct DashResolvedStream {
    pub representation_id: String,
    pub content_type: String, // "video" or "audio"
    pub mime_type: String,
    pub codecs: Option<String>,
    pub init_segment: Option<ResolvedDashSegment>,
    pub media_segments: Vec<ResolvedDashSegment>,
    pub total_duration: f64,
}

/// Parses an ISO 8601 duration (e.g. `PT30S`, `PT1M15.5S`, `PT1H2M30S`).
pub fn parse_iso8601_duration(s: &str) -> Option<f64> {
    let s = s.trim();
    if !s.starts_with('P') {
        return None;
    }

    let mut total_seconds = 0.0;
    let mut in_time = false;
    let mut num_buf = String::new();

    for c in s.chars().skip(1) {
        if c == 'T' {
            in_time = true;
            num_buf.clear();
            continue;
        }

        if c.is_ascii_digit() || c == '.' {
            num_buf.push(c);
            continue;
        }

        let val: f64 = num_buf.parse().ok()?;
        num_buf.clear();

        match c {
            'Y' => total_seconds += val * 365.25 * 86400.0,
            'M' if !in_time => total_seconds += val * 30.0 * 86400.0,
            'D' => total_seconds += val * 86400.0,
            'H' => total_seconds += val * 3600.0,
            'M' if in_time => total_seconds += val * 60.0,
            'S' => total_seconds += val,
            _ => return None,
        }
    }

    Some(total_seconds)
}

/// Formats a DASH SegmentTemplate pattern (e.g. `$RepresentationID$`, `$Number%05d$`, `$Time$`, `$Bandwidth$`).
pub fn format_segment_template(
    pattern: &str,
    rep_id: &str,
    number: Option<u64>,
    time: Option<u64>,
    bandwidth: Option<u64>,
) -> String {
    let mut result = String::with_capacity(pattern.len() + 16);
    let mut chars = pattern.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '$' {
            if chars.peek() == Some(&'$') {
                chars.next();
                result.push('$');
                continue;
            }

            // Extract identifier
            let mut tag = String::new();
            for inner in chars.by_ref() {
                if inner == '$' {
                    break;
                }
                tag.push(inner);
            }

            // Check for format specifier (e.g. Number%05d)
            let (name, fmt_spec) = if let Some((n, f)) = tag.split_once('%') {
                (n, Some(f))
            } else {
                (tag.as_str(), None)
            };

            match name {
                "RepresentationID" => result.push_str(rep_id),
                "Number" => {
                    let num = number.unwrap_or(1);
                    if let Some(spec) = fmt_spec {
                        result.push_str(&format_with_spec(num, spec));
                    } else {
                        result.push_str(&num.to_string());
                    }
                }
                "Time" => {
                    let t = time.unwrap_or(0);
                    if let Some(spec) = fmt_spec {
                        result.push_str(&format_with_spec(t, spec));
                    } else {
                        result.push_str(&t.to_string());
                    }
                }
                "Bandwidth" => {
                    let bw = bandwidth.unwrap_or(0);
                    if let Some(spec) = fmt_spec {
                        result.push_str(&format_with_spec(bw, spec));
                    } else {
                        result.push_str(&bw.to_string());
                    }
                }
                _ => {
                    // Unknown tag: keep original
                    result.push('$');
                    result.push_str(&tag);
                    result.push('$');
                }
            }
        } else {
            result.push(c);
        }
    }

    result
}

fn format_with_spec(val: u64, spec: &str) -> String {
    if let Some(width_str) = spec.strip_prefix('0').and_then(|s| s.strip_suffix('d')) {
        if let Ok(width) = width_str.parse::<usize>() {
            return format!("{:0width$}", val, width = width);
        }
    }
    val.to_string()
}

/// Parses a byte range string e.g. "0-500" into (start, end).
pub fn parse_range_spec(s: &str) -> Option<(u64, u64)> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() == 2 {
        let start = parts[0].trim().parse::<u64>().ok()?;
        let end = parts[1].trim().parse::<u64>().ok()?;
        Some((start, end))
    } else {
        None
    }
}

/// Resolves a possibly relative URL against a base URL string.
pub fn resolve_dash_url(base: &str, relative: &str) -> Result<String> {
    if relative.starts_with("http://") || relative.starts_with("https://") {
        return Ok(relative.to_string());
    }

    let parsed_base = Url::parse(base)
        .map_err(|e| EngineError::Other(format!("Invalid BaseURL '{}': {}", base, e)))?;

    let resolved = parsed_base.join(relative).map_err(|e| {
        EngineError::Other(format!(
            "Failed to resolve '{}' against '{}': {}",
            relative, base, e
        ))
    })?;

    Ok(resolved.to_string())
}

/// Parses an MPEG-DASH XML manifest string into `DashManifest`.
pub fn parse_mpd_manifest(xml: &str, base_url: &str) -> Result<DashManifest> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut is_dynamic = false;
    let mut media_presentation_duration: Option<f64> = None;
    let mut min_buffer_time: Option<f64> = None;
    let mut root_base_urls: Vec<String> = Vec::new();
    let mut periods: Vec<DashPeriod> = Vec::new();

    let mut current_period: Option<DashPeriod> = None;
    let mut current_adaptation_set: Option<DashAdaptationSet> = None;
    let mut current_representation: Option<DashRepresentation> = None;
    let mut current_segment_template: Option<DashSegmentTemplate> = None;
    let mut current_timeline: Option<Vec<DashTimelineEntry>> = None;
    let mut current_segment_list: Option<DashSegmentList> = None;
    let mut current_segment_base: Option<DashSegmentBase> = None;

    let mut current_tag = String::new();
    let mut text_buf = String::new();

    let mut buf = Vec::new();

    loop {
        let event = reader.read_event_into(&mut buf);
        let is_empty = matches!(event, Ok(Event::Empty(_)));

        match event {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                current_tag = tag_name.clone();

                match tag_name.as_str() {
                    "MPD" => {
                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            match key.as_str() {
                                "type" => {
                                    if val.eq_ignore_ascii_case("dynamic") {
                                        is_dynamic = true;
                                    }
                                }
                                "mediaPresentationDuration" => {
                                    media_presentation_duration = parse_iso8601_duration(&val);
                                }
                                "minBufferTime" => {
                                    min_buffer_time = parse_iso8601_duration(&val);
                                }
                                _ => {}
                            }
                        }
                    }

                    "Period" => {
                        let mut p_id: Option<String> = None;
                        let mut p_start: Option<f64> = None;
                        let mut p_duration: Option<f64> = None;

                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            match key.as_str() {
                                "id" => p_id = Some(val),
                                "start" => {
                                    p_start = parse_iso8601_duration(&val)
                                        .or_else(|| f64::from_str(&val).ok())
                                }
                                "duration" => {
                                    p_duration = parse_iso8601_duration(&val)
                                        .or_else(|| f64::from_str(&val).ok())
                                }
                                _ => {}
                            }
                        }

                        current_period = Some(DashPeriod {
                            id: p_id,
                            start: p_start,
                            duration: p_duration,
                            base_urls: Vec::new(),
                            adaptation_sets: Vec::new(),
                        });
                    }

                    "AdaptationSet" => {
                        let mut a_id: Option<String> = None;
                        let mut content_type: Option<String> = None;
                        let mut mime_type: Option<String> = None;
                        let mut codecs: Option<String> = None;
                        let mut lang: Option<String> = None;

                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            match key.as_str() {
                                "id" => a_id = Some(val),
                                "contentType" => content_type = Some(val.to_lowercase()),
                                "mimeType" => mime_type = Some(val.to_lowercase()),
                                "codecs" => codecs = Some(val),
                                "lang" => lang = Some(val),
                                _ => {}
                            }
                        }

                        current_adaptation_set = Some(DashAdaptationSet {
                            id: a_id,
                            content_type,
                            mime_type,
                            codecs,
                            lang,
                            base_urls: Vec::new(),
                            segment_template: None,
                            content_protection: Vec::new(),
                            representations: Vec::new(),
                        });
                    }

                    "ContentProtection" => {
                        let mut scheme_id_uri = String::new();
                        let mut value: Option<String> = None;

                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            match key.as_str() {
                                "schemeIdUri" => scheme_id_uri = val,
                                "value" => value = Some(val),
                                _ => {}
                            }
                        }

                        if let Some(ref mut ad) = current_adaptation_set {
                            ad.content_protection.push(DashContentProtection {
                                scheme_id_uri,
                                value,
                            });
                        }
                    }

                    "Representation" => {
                        let mut r_id = String::new();
                        let mut bandwidth: u64 = 0;
                        let mut width: Option<u32> = None;
                        let mut height: Option<u32> = None;
                        let mut codecs: Option<String> = None;
                        let mut mime_type: Option<String> = None;

                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            match key.as_str() {
                                "id" => r_id = val,
                                "bandwidth" => bandwidth = val.parse::<u64>().unwrap_or(0),
                                "width" => width = val.parse::<u32>().ok(),
                                "height" => height = val.parse::<u32>().ok(),
                                "codecs" => codecs = Some(val),
                                "mimeType" => mime_type = Some(val.to_lowercase()),
                                _ => {}
                            }
                        }

                        // Inherit codecs and mime_type from AdaptationSet if omitted
                        if let Some(ref ad) = current_adaptation_set {
                            if codecs.is_none() {
                                codecs = ad.codecs.clone();
                            }
                            if mime_type.is_none() {
                                mime_type = ad.mime_type.clone();
                            }
                        }

                        current_representation = Some(DashRepresentation {
                            id: r_id,
                            bandwidth,
                            width,
                            height,
                            codecs,
                            mime_type,
                            base_urls: Vec::new(),
                            segment_template: None,
                            segment_list: None,
                            segment_base: None,
                        });
                    }

                    "SegmentTemplate" => {
                        let mut timescale: u64 = 1;
                        let mut duration: Option<u64> = None;
                        let mut initialization: Option<String> = None;
                        let mut media: Option<String> = None;
                        let mut start_number: u64 = 1;
                        let mut presentation_time_offset: u64 = 0;

                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            match key.as_str() {
                                "timescale" => timescale = val.parse::<u64>().unwrap_or(1),
                                "duration" => duration = val.parse::<u64>().ok(),
                                "initialization" => initialization = Some(val),
                                "media" => media = Some(val),
                                "startNumber" => start_number = val.parse::<u64>().unwrap_or(1),
                                "presentationTimeOffset" => {
                                    presentation_time_offset = val.parse::<u64>().unwrap_or(0);
                                }
                                _ => {}
                            }
                        }

                        let st = DashSegmentTemplate {
                            timescale,
                            duration,
                            initialization,
                            media,
                            start_number,
                            presentation_time_offset,
                            timeline: None,
                        };

                        if is_empty {
                            if let Some(ref mut rep) = current_representation {
                                rep.segment_template = Some(st);
                            } else if let Some(ref mut ad) = current_adaptation_set {
                                ad.segment_template = Some(st);
                            }
                        } else {
                            current_segment_template = Some(st);
                        }
                    }

                    "SegmentTimeline" => {
                        current_timeline = Some(Vec::new());
                    }

                    "S" => {
                        let mut t: Option<u64> = None;
                        let mut d: u64 = 0;
                        let mut r: i64 = 0;

                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            match key.as_str() {
                                "t" => t = val.parse::<u64>().ok(),
                                "d" => d = val.parse::<u64>().unwrap_or(0),
                                "r" => r = val.parse::<i64>().unwrap_or(0),
                                _ => {}
                            }
                        }

                        if let Some(ref mut tl) = current_timeline {
                            tl.push(DashTimelineEntry { t, d, r });
                        }
                    }

                    "SegmentList" => {
                        let mut timescale: u64 = 1;
                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            if key == "timescale" {
                                timescale = val.parse::<u64>().unwrap_or(1);
                            }
                        }

                        let sl = DashSegmentList {
                            timescale,
                            initialization: None,
                            segment_urls: Vec::new(),
                        };

                        if is_empty {
                            if let Some(ref mut rep) = current_representation {
                                rep.segment_list = Some(sl);
                            }
                        } else {
                            current_segment_list = Some(sl);
                        }
                    }

                    "SegmentBase" => {
                        let mut timescale: u64 = 1;
                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            if key == "timescale" {
                                timescale = val.parse::<u64>().unwrap_or(1);
                            }
                        }

                        let sb = DashSegmentBase {
                            timescale,
                            initialization: None,
                            index_range: None,
                        };

                        if is_empty {
                            if let Some(ref mut rep) = current_representation {
                                rep.segment_base = Some(sb);
                            }
                        } else {
                            current_segment_base = Some(sb);
                        }
                    }

                    "Initialization" => {
                        let mut source_url: Option<String> = None;
                        let mut range: Option<(u64, u64)> = None;

                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            match key.as_str() {
                                "sourceURL" => source_url = Some(val),
                                "range" => range = parse_range_spec(&val),
                                _ => {}
                            }
                        }

                        let init = DashInitialization { source_url, range };
                        if let Some(ref mut sl) = current_segment_list {
                            sl.initialization = Some(init);
                        } else if let Some(ref mut sb) = current_segment_base {
                            sb.initialization = Some(init);
                        }
                    }

                    "SegmentURL" => {
                        let mut media: Option<String> = None;
                        let mut media_range: Option<(u64, u64)> = None;

                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            match key.as_str() {
                                "media" => media = Some(val),
                                "mediaRange" => media_range = parse_range_spec(&val),
                                _ => {}
                            }
                        }

                        if let Some(ref mut sl) = current_segment_list {
                            sl.segment_urls.push(DashSegmentUrl { media, media_range });
                        }
                    }

                    _ => {}
                }
            }

            Ok(Event::Text(ref e)) => {
                let txt = String::from_utf8_lossy(e.as_ref()).to_string();
                text_buf.push_str(&txt);
            }

            Ok(Event::End(ref e)) => {
                let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_string();

                match tag_name.as_str() {
                    "BaseURL" => {
                        let trimmed = text_buf.trim();
                        if !trimmed.is_empty() {
                            let base_str = trimmed.to_string();
                            if let Some(ref mut rep) = current_representation {
                                rep.base_urls.push(base_str);
                            } else if let Some(ref mut ad) = current_adaptation_set {
                                ad.base_urls.push(base_str);
                            } else if let Some(ref mut per) = current_period {
                                per.base_urls.push(base_str);
                            } else {
                                root_base_urls.push(base_str);
                            }
                        }
                        text_buf.clear();
                    }

                    "SegmentTimeline" => {
                        if let (Some(ref mut st), Some(tl)) =
                            (&mut current_segment_template, current_timeline.take())
                        {
                            st.timeline = Some(tl);
                        }
                    }

                    "SegmentTemplate" => {
                        if let Some(st) = current_segment_template.take() {
                            if let Some(ref mut rep) = current_representation {
                                rep.segment_template = Some(st);
                            } else if let Some(ref mut ad) = current_adaptation_set {
                                ad.segment_template = Some(st);
                            }
                        }
                    }

                    "SegmentList" => {
                        if let Some(sl) = current_segment_list.take() {
                            if let Some(ref mut rep) = current_representation {
                                rep.segment_list = Some(sl);
                            }
                        }
                    }

                    "SegmentBase" => {
                        if let Some(sb) = current_segment_base.take() {
                            if let Some(ref mut rep) = current_representation {
                                rep.segment_base = Some(sb);
                            }
                        }
                    }

                    "Representation" => {
                        if let Some(mut rep) = current_representation.take() {
                            // Inherit AdaptationSet-level SegmentTemplate if rep doesn't define its own
                            if rep.segment_template.is_none()
                                && rep.segment_list.is_none()
                                && rep.segment_base.is_none()
                            {
                                if let Some(ref ad) = current_adaptation_set {
                                    rep.segment_template = ad.segment_template.clone();
                                }
                            }

                            if let Some(ref mut ad) = current_adaptation_set {
                                ad.representations.push(rep);
                            }
                        }
                    }

                    "AdaptationSet" => {
                        if let Some(ad) = current_adaptation_set.take() {
                            if let Some(ref mut p) = current_period {
                                p.adaptation_sets.push(ad);
                            }
                        }
                    }

                    "Period" => {
                        if let Some(p) = current_period.take() {
                            periods.push(p);
                        }
                    }

                    _ => {}
                }

                current_tag.clear();
                text_buf.clear();
            }

            Ok(Event::Eof) => break,

            Err(e) => {
                return Err(EngineError::Other(format!(
                    "Malformed MPEG-DASH XML manifest: {}",
                    e
                )));
            }

            _ => {}
        }
        buf.clear();
    }

    if periods.is_empty() {
        return Err(EngineError::Other(
            "MPEG-DASH manifest contains zero Periods".to_string(),
        ));
    }

    // Default root BaseURL to the manifest URL if no root <BaseURL> was specified
    if root_base_urls.is_empty() {
        root_base_urls.push(base_url.to_string());
    }

    let manifest = DashManifest {
        is_dynamic,
        media_presentation_duration,
        min_buffer_time,
        base_urls: root_base_urls,
        periods,
    };

    Ok(manifest)
}

/// Resolves the effective BaseURL by combining Manifest -> Period -> AdaptationSet -> Representation.
pub fn resolve_effective_base_url(
    manifest_base: &str,
    period_bases: &[String],
    adaptation_bases: &[String],
    representation_bases: &[String],
) -> Result<String> {
    let mut current = manifest_base.to_string();

    for p_base in period_bases {
        current = resolve_dash_url(&current, p_base)?;
    }
    for a_base in adaptation_bases {
        current = resolve_dash_url(&current, a_base)?;
    }
    for r_base in representation_bases {
        current = resolve_dash_url(&current, r_base)?;
    }

    Ok(current)
}

/// Selected audio and video tracks for DASH playback.
#[derive(Debug, Clone, Copy)]
pub struct SelectedDashTracks<'a> {
    pub period: &'a DashPeriod,
    pub video_adaptation: &'a DashAdaptationSet,
    pub video_representation: &'a DashRepresentation,
    pub audio: Option<(&'a DashAdaptationSet, &'a DashRepresentation)>,
}

/// Automatically selects the best video and audio representations without forcing manual selection.
pub fn select_best_representations(manifest: &DashManifest) -> Result<SelectedDashTracks<'_>> {
    if manifest.is_dynamic {
        return Err(EngineError::Other(
            "Live MPEG-DASH streaming is not supported in VOD engine (planned for Gate 7). Only static VOD manifests (type=\"static\") are supported."
                .to_string(),
        ));
    }

    let first_period = manifest
        .periods
        .first()
        .ok_or_else(|| EngineError::Other("No periods found in MPD".to_string()))?;

    // Check for DRM ContentProtection across all adaptation sets
    for ad in &first_period.adaptation_sets {
        for cp in &ad.content_protection {
            let uri = cp.scheme_id_uri.to_lowercase();
            // DRM UUIDs: Widevine, PlayReady, FairPlay
            if uri.contains("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")
                || uri.contains("9a04f079-9840-4286-ab92-e65be0885f95")
                || uri.contains("94ce86fb-07ff-4f43-adb8-93d2fa968ca2")
                || uri.contains("mp4protection")
            {
                return Err(EngineError::Other(format!(
                    "Unsupported protected MPEG-DASH DRM scheme '{}'. TORI does not bypass DRM or unauthorized encryption.",
                    cp.scheme_id_uri
                )));
            }
        }
    }

    // Locate video adaptation sets
    let mut video_candidates: Vec<(&DashAdaptationSet, &DashRepresentation)> = Vec::new();
    let mut audio_candidates: Vec<(&DashAdaptationSet, &DashRepresentation)> = Vec::new();

    for ad in &first_period.adaptation_sets {
        let is_video = ad.content_type.as_deref() == Some("video")
            || ad
                .mime_type
                .as_deref()
                .map(|m| m.starts_with("video/"))
                .unwrap_or(false);

        let is_audio = ad.content_type.as_deref() == Some("audio")
            || ad
                .mime_type
                .as_deref()
                .map(|m| m.starts_with("audio/"))
                .unwrap_or(false);

        for rep in &ad.representations {
            let rep_is_video = is_video
                || rep
                    .mime_type
                    .as_deref()
                    .map(|m| m.starts_with("video/"))
                    .unwrap_or(false)
                || rep.width.is_some()
                || rep.height.is_some();

            let rep_is_audio = is_audio
                || rep
                    .mime_type
                    .as_deref()
                    .map(|m| m.starts_with("audio/"))
                    .unwrap_or(false);

            if rep_is_video {
                video_candidates.push((ad, rep));
            } else if rep_is_audio {
                audio_candidates.push((ad, rep));
            }
        }
    }

    if video_candidates.is_empty() {
        return Err(EngineError::Other(
            "No compatible video representations found in MPEG-DASH manifest".to_string(),
        ));
    }

    // Select video: highest bandwidth <= 1080p (width <= 1920)
    let best_video = video_candidates
        .iter()
        .filter(|(_, r)| r.width.map(|w| w <= 1920).unwrap_or(true))
        .max_by_key(|(_, r)| r.bandwidth)
        .or_else(|| video_candidates.iter().max_by_key(|(_, r)| r.bandwidth))
        .copied()
        .ok_or_else(|| EngineError::Other("Failed to select video representation".to_string()))?;

    // Select audio: highest bandwidth
    let best_audio = audio_candidates
        .iter()
        .max_by_key(|(_, r)| r.bandwidth)
        .copied();

    Ok(SelectedDashTracks {
        period: first_period,
        video_adaptation: best_video.0,
        video_representation: best_video.1,
        audio: best_audio,
    })
}

/// Resolves all segment URLs and timing for a given Representation.
pub fn resolve_representation_segments(
    manifest: &DashManifest,
    period: &DashPeriod,
    adaptation_set: &DashAdaptationSet,
    representation: &DashRepresentation,
    content_type: &str,
) -> Result<DashResolvedStream> {
    let manifest_root = manifest
        .base_urls
        .first()
        .cloned()
        .unwrap_or_else(|| "http://localhost/".to_string());

    let effective_base = resolve_effective_base_url(
        &manifest_root,
        &period.base_urls,
        &adaptation_set.base_urls,
        &representation.base_urls,
    )?;

    let period_duration = period
        .duration
        .or(manifest.media_presentation_duration)
        .unwrap_or(0.0);

    let mime_type = representation
        .mime_type
        .clone()
        .or_else(|| adaptation_set.mime_type.clone())
        .unwrap_or_else(|| {
            if content_type == "video" {
                "video/mp4".to_string()
            } else {
                "audio/mp4".to_string()
            }
        });

    let codecs = representation
        .codecs
        .clone()
        .or_else(|| adaptation_set.codecs.clone());

    let mut init_segment: Option<ResolvedDashSegment> = None;
    let mut media_segments: Vec<ResolvedDashSegment> = Vec::new();
    let mut total_duration = 0.0;

    // Check SegmentTemplate
    if let Some(ref st) = representation.segment_template {
        let timescale = st.timescale.max(1);

        // Initialization segment
        if let Some(ref init_pattern) = st.initialization {
            let formatted_init = format_segment_template(
                init_pattern,
                &representation.id,
                None,
                None,
                Some(representation.bandwidth),
            );
            let resolved_init_uri = resolve_dash_url(&effective_base, &formatted_init)?;
            init_segment = Some(ResolvedDashSegment {
                uri: resolved_init_uri,
                byterange: None,
                duration_seconds: 0.0,
                sequence_number: 0,
            });
        }

        // Media segments from SegmentTimeline
        if let Some(ref timeline) = st.timeline {
            let media_pattern = st.media.as_deref().ok_or_else(|| {
                EngineError::Other("SegmentTemplate missing media attribute".to_string())
            })?;

            let mut current_time: u64 = 0;
            let mut current_number: u64 = st.start_number;

            for entry in timeline {
                if let Some(t) = entry.t {
                    current_time = t;
                }

                let d = entry.d;
                let count = 1 + entry.r.max(0) as u64;

                for _ in 0..count {
                    let formatted_media = format_segment_template(
                        media_pattern,
                        &representation.id,
                        Some(current_number),
                        Some(current_time),
                        Some(representation.bandwidth),
                    );

                    let resolved_uri = resolve_dash_url(&effective_base, &formatted_media)?;
                    let seg_dur = d as f64 / timescale as f64;

                    media_segments.push(ResolvedDashSegment {
                        uri: resolved_uri,
                        byterange: None,
                        duration_seconds: seg_dur,
                        sequence_number: current_number,
                    });

                    total_duration += seg_dur;
                    current_time += d;
                    current_number += 1;
                }
            }
        } else if let Some(d) = st.duration {
            // SegmentTemplate with duration (number-based addressing)
            let media_pattern = st.media.as_deref().ok_or_else(|| {
                EngineError::Other("SegmentTemplate missing media attribute".to_string())
            })?;

            let seg_duration_sec = d as f64 / timescale as f64;
            let count = if seg_duration_sec > 0.0 && period_duration > 0.0 {
                (period_duration / seg_duration_sec).ceil() as u64
            } else {
                1
            };

            for i in 0..count {
                let number = st.start_number + i;
                let time = i * d;

                let formatted_media = format_segment_template(
                    media_pattern,
                    &representation.id,
                    Some(number),
                    Some(time),
                    Some(representation.bandwidth),
                );

                let resolved_uri = resolve_dash_url(&effective_base, &formatted_media)?;

                media_segments.push(ResolvedDashSegment {
                    uri: resolved_uri,
                    byterange: None,
                    duration_seconds: seg_duration_sec,
                    sequence_number: number,
                });

                total_duration += seg_duration_sec;
            }
        }
    } else if let Some(ref sl) = representation.segment_list {
        // SegmentList addressing
        if let Some(ref init) = sl.initialization {
            let uri = init
                .source_url
                .as_deref()
                .map(|u| resolve_dash_url(&effective_base, u))
                .transpose()?
                .unwrap_or_else(|| effective_base.clone());

            init_segment = Some(ResolvedDashSegment {
                uri,
                byterange: init.range,
                duration_seconds: 0.0,
                sequence_number: 0,
            });
        }

        let seg_dur = if !sl.segment_urls.is_empty() && period_duration > 0.0 {
            period_duration / sl.segment_urls.len() as f64
        } else {
            1.0
        };

        for (i, seg) in sl.segment_urls.iter().enumerate() {
            let uri = seg
                .media
                .as_deref()
                .map(|u| resolve_dash_url(&effective_base, u))
                .transpose()?
                .unwrap_or_else(|| effective_base.clone());

            media_segments.push(ResolvedDashSegment {
                uri,
                byterange: seg.media_range,
                duration_seconds: seg_dur,
                sequence_number: (i + 1) as u64,
            });
            total_duration += seg_dur;
        }
    } else if let Some(ref sb) = representation.segment_base {
        // SegmentBase addressing (single file with byte-range index)
        if let Some(ref init) = sb.initialization {
            let uri = init
                .source_url
                .as_deref()
                .map(|u| resolve_dash_url(&effective_base, u))
                .transpose()?
                .unwrap_or_else(|| effective_base.clone());

            init_segment = Some(ResolvedDashSegment {
                uri,
                byterange: init.range,
                duration_seconds: 0.0,
                sequence_number: 0,
            });
        }

        // If indexRange is given, we add the media segment for the container
        media_segments.push(ResolvedDashSegment {
            uri: effective_base,
            byterange: None,
            duration_seconds: period_duration,
            sequence_number: 1,
        });
        total_duration = period_duration;
    } else {
        return Err(EngineError::Other(
            "Representation does not define a supported SegmentTemplate, SegmentList, or SegmentBase"
                .to_string(),
        ));
    }

    if media_segments.is_empty() {
        return Err(EngineError::Other(
            "MPEG-DASH representation resolved to zero media segments".to_string(),
        ));
    }

    Ok(DashResolvedStream {
        representation_id: representation.id.clone(),
        content_type: content_type.to_string(),
        mime_type,
        codecs,
        init_segment,
        media_segments,
        total_duration,
    })
}
