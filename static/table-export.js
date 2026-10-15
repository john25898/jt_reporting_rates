/* ============================================================================
   table-export.js — make every table on the page downloadable.

   Adds a small "CSV / Excel" toolbar above each <table> and, for pages with
   more than one table, an "All tables" button that produces a single workbook
   with one sheet per table.

   Everything is generated in the browser — no libraries, no build step:

     CSV   UTF-8 with BOM (so Excel shows accents correctly), CRLF rows,
           thousands separators removed so numbers arrive as numbers.

     XLSX  A real Excel workbook (zipped OOXML with stored, uncompressed
           entries) so Excel opens it without the "file format doesn't match
           the extension" warning you get from HTML-in-.xls. Headers are
           styled, the highlighted consumption/closing-balance columns keep
           their highlight, percentages stay numeric and the header row is
           frozen with an auto-filter.

   Anything the UI decorates but a spreadsheet should not carry (status pills
   built from icons, rate bars, "add sub-county, county" suffixes) can be kept
   out with data-export-skip; a single cell can be overridden with data-export.

   Per table you may also set:
     data-export-name  file name / sheet title for that table
     data-export-sub   subtitle line written under the title in Excel

   data-export-skip works in three places:
     on a <th>   drops that entire column from the export
     on any node drops just that node's text from its cell
     on a cell   (with data-export) replaces the cell's value outright
   ========================================================================= */
(function (global) {
  "use strict";

  var ICON = "\u2913"; /* ⤓ */
  var MIME_XLSX =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  var MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  /* ------------------------------------------------------------- text utils */

  function tidy(s) {
    return String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim();
  }

  function xmlEsc(s) {
    return String(s == null ? "" : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/[&<>"']/g, function (c) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        }[c];
      });
  }

  /* File-name / sheet-title safe slug. */
  function slug(s, max) {
    var t = tidy(s)
      .replace(/[^\w]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!t) t = "table";
    if (max && t.length > max) t = t.slice(0, max).replace(/_+$/, "");
    return t;
  }

  /* Excel sheet names: <= 31 chars, none of \ / ? * [ ] : */
  function sheetName(s) {
    var n = tidy(s)
      .replace(/[\\/?*[\]:]/g, "-")
      .replace(/-+/g, "-");
    if (n.length > 31) n = n.slice(0, 31).replace(/[-\s]+$/, "");
    return n || "Table";
  }

  function fmtYm(ym) {
    if (!/^\d{6}$/.test(String(ym || ""))) return String(ym || "");
    return MONTHS[parseInt(ym.slice(4, 6), 10) - 1] + " " + ym.slice(0, 4);
  }

  function timestamp() {
    var d = new Date();
    var p = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    return (
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      "_" +
      p(d.getHours()) +
      p(d.getMinutes())
    );
  }

  /* ------------------------------------------------------- reading a table  */

  var DASH = /^[\u2012\u2013\u2014\u2015-]$/;

  /* One cell -> the string a spreadsheet should hold. */
  function cellText(cell) {
    if (!cell) return "";
    if (cell.dataset && cell.dataset.export != null) {
      return tidy(cell.dataset.export);
    }
    var clone = cell.cloneNode(true);
    var drop = clone.querySelectorAll(
      "[data-export-skip], button, svg, img, input",
    );
    for (var i = 0; i < drop.length; i++)
      drop[i].parentNode.removeChild(drop[i]);
    var t = tidy(clone.textContent);
    if (!t || DASH.test(t)) return ""; /* "—" means "no data", not a value */
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
    return t;
  }

  function headerText(th) {
    if (!th) return "";
    /* the tracer table shows a short label but carries the full one in title */
    return tidy(th.getAttribute("title") || th.textContent);
  }

  /* Pull a table out of the DOM into a plain {headers, body, footer} model.
     A <th data-export-skip> drops that whole column — used for purely visual
     columns (little bars) that hold no value. */
  function modelFromTable(table) {
    var headRow = table.querySelector("thead tr:last-child");
    var headers = [];
    var highlight = [];
    var skip = [];
    if (headRow) {
      var ths = [];
      for (var i = 0; i < headRow.children.length; i++) {
        if (/^th$/i.test(headRow.children[i].tagName))
          ths.push(headRow.children[i]);
      }
      headers = ths.map(headerText);
      for (var j = 0; j < ths.length; j++) {
        if (ths[j].classList.contains("hl-col")) highlight.push(j);
        if (ths[j].dataset && ths[j].dataset.exportSkip != null) skip.push(j);
      }
    }

    var body = [];
    var tbody = table.tBodies && table.tBodies[0];
    if (tbody) {
      for (var r = 0; r < tbody.rows.length; r++) {
        var tr = tbody.rows[r];
        /* honour the on-screen search filter: download what you can see */
        if (tr.style && tr.style.display === "none") continue;
        var cells = [];
        for (var c = 0; c < tr.cells.length; c++) cells.push(tr.cells[c]);
        /* a lone colspan cell is the "nothing to show" placeholder */
        if (cells.length === 1 && (cells[0].colSpan || 1) > 1) continue;
        body.push(cells.map(cellText));
      }
    }

    var footer = [];
    if (table.tFoot) {
      for (var f = 0; f < table.tFoot.rows.length; f++) {
        var ftr = table.tFoot.rows[f];
        var fcells = [];
        for (var k = 0; k < ftr.cells.length; k++) fcells.push(ftr.cells[k]);
        footer.push(fcells.map(cellText));
      }
    }

    if (skip.length) {
      var keep = function (row) {
        return row.filter(function (_, idx) {
          return skip.indexOf(idx) === -1;
        });
      };
      var shift = function (idx) {
        var before = 0;
        for (var s = 0; s < skip.length; s++) if (skip[s] < idx) before++;
        return idx - before;
      };
      headers = keep(headers);
      body = body.map(keep);
      footer = footer.map(keep);
      highlight = highlight.map(shift);
    }

    var ncol = headers.length;
    body.concat(footer).forEach(function (row) {
      if (row.length > ncol) ncol = row.length;
    });
    if (!ncol) return null;

    if (!headers.length) {
      for (var n = 0; n < ncol; n++) headers.push("Column " + (n + 1));
    }
    var pad = function (row) {
      var out = row.slice(0, ncol);
      while (out.length < ncol) out.push("");
      return out;
    };

    return {
      headers: pad(headers),
      body: body.map(pad),
      footer: footer.map(pad),
      highlight: highlight,
      ncol: ncol,
    };
  }

  function tableName(table) {
    if (table.dataset && table.dataset.exportName) {
      return tidy(table.dataset.exportName);
    }
    var card = table.closest ? table.closest(".card") : null;
    var head = card && card.querySelector("h2, h3, h4");
    if (head) {
      var t = tidy(head.textContent);
      if (t) return t;
    }
    var caption = table.querySelector("caption");
    if (caption) return tidy(caption.textContent);
    return "Table";
  }

  function tableSubtitle(table) {
    if (table.dataset && table.dataset.exportSub) {
      return tidy(table.dataset.exportSub);
    }
    var bits = [];
    var period = document.getElementById("period-select");
    if (period && period.value) bits.push("Period " + fmtYm(period.value));
    var sum = document.getElementById("scope-summary");
    if (sum) {
      var s = tidy(sum.textContent);
      if (s && s.length < 160) bits.push(s);
    }
    bits.push("Downloaded " + new Date().toLocaleString());
    return bits.join(" · ");
  }

  /* --------------------------------------------------------------- CSV out  */

  function csvField(v) {
    var s = v == null ? "" : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /* CSV stays a clean data file: header line first, then body, then totals. */
  function toCsv(model) {
    var rows = [model.headers].concat(model.body, model.footer);
    return (
      rows
        .map(function (r) {
          return r.map(csvField).join(",");
        })
        .join("\r\n") + "\r\n"
    );
  }

  /* -------------------------------------------------------------- XLSX out  */

  function colRef(n) {
    var s = "";
    n += 1;
    while (n > 0) {
      var r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  var S_PLAIN = 0;
  var S_BOLD = 1;
  var S_TITLE = 2;
  var S_HEADER = 3;
  var S_HL = 4;
  var S_HL_BOLD = 5;
  var S_PCT = 6;
  var S_PCT_HL = 7;
  var S_SUB = 8;

  function pctValue(v) {
    var n = parseFloat(v) / 100;
    if (!isFinite(n)) return "0";
    var s = n.toPrecision(12);
    if (s.indexOf("e") >= 0) return String(n);
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }

  /* sheet = { name, title, subtitle, headers, body, footer, highlight } */
  function worksheetXml(sheet) {
    var headers = sheet.headers || [];
    var body = sheet.body || [];
    var footer = sheet.footer || [];
    var ncol = Math.max(headers.length, 1);
    var hl = {};
    (sheet.highlight || []).forEach(function (c) {
      if (c >= 0 && c < ncol) hl[c] = 1;
    });

    function styleFor(col, kind, isPct) {
      if (kind === "header") return S_HEADER;
      if (kind === "footer") return hl[col] ? S_HL_BOLD : S_BOLD;
      if (isPct) return hl[col] ? S_PCT_HL : S_PCT;
      return hl[col] ? S_HL : S_PLAIN;
    }

    function cell(ref, raw, kind, col) {
      var v = raw == null ? "" : String(raw);
      var isPct = /^-?\d+(\.\d+)?%$/.test(v);
      var s = ' s="' + styleFor(col, kind, isPct) + '"';
      if (v === "") return '<c r="' + ref + '"' + s + "/>";
      if (isPct) {
        return '<c r="' + ref + '"' + s + "><v>" + pctValue(v) + "</v></c>";
      }
      if (/^-?\d+(\.\d+)?$/.test(v)) {
        return '<c r="' + ref + '"' + s + "><v>" + v + "</v></c>";
      }
      return (
        '<c r="' +
        ref +
        '"' +
        s +
        ' t="inlineStr"><is><t xml:space="preserve">' +
        xmlEsc(v) +
        "</t></is></c>"
      );
    }

    function rowXml(rowNum, vals, kind, height) {
      var attr = height ? ' ht="' + height + '" customHeight="1"' : "";
      if (!vals) return '<row r="' + rowNum + '"' + attr + "/>";
      var cells = "";
      for (var c = 0; c < ncol; c++) {
        cells += cell(colRef(c) + rowNum, vals[c], kind, c);
      }
      return '<row r="' + rowNum + '"' + attr + ">" + cells + "</row>";
    }

    /* Column widths from the longest value in each column. */
    var widths = [];
    for (var c2 = 0; c2 < ncol; c2++) {
      var w = String(headers[c2] || "").length;
      body.concat(footer).forEach(function (r) {
        w = Math.max(w, String(r[c2] == null ? "" : r[c2]).length);
      });
      widths.push(Math.min(46, Math.max(10, w + 2)));
    }
    if (String(sheet.title || "").length > widths[0]) {
      widths[0] = Math.min(46, String(sheet.title).length);
    }

    var HEADER_ROW = 4; /* 1 title, 2 subtitle, 3 spacer, 4 header */
    var lastRow = HEADER_ROW + body.length + footer.length;

    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    );
    out.push(
      '<sheetViews><sheetView workbookViewId="0">' +
        '<pane ySplit="' +
        HEADER_ROW +
        '" topLeftCell="A' +
        (HEADER_ROW + 1) +
        '" activePane="bottomLeft" state="frozen"/>' +
        "</sheetView></sheetViews>",
    );
    out.push('<sheetFormatPr defaultRowHeight="15"/>');
    out.push(
      "<cols>" +
        widths
          .map(function (wd, i) {
            return (
              '<col min="' +
              (i + 1) +
              '" max="' +
              (i + 1) +
              '" width="' +
              wd +
              '" customWidth="1"/>'
            );
          })
          .join("") +
        "</cols>",
    );
    out.push("<sheetData>");

    /* title + subtitle + spacer */
    out.push(
      '<row r="1" ht="20" customHeight="1"><c r="A1" s="' +
        S_TITLE +
        '" t="inlineStr"><is><t xml:space="preserve">' +
        xmlEsc(tidy(sheet.title)) +
        "</t></is></c></row>",
    );
    out.push(
      '<row r="2"><c r="A2" s="' +
        S_SUB +
        '" t="inlineStr"><is><t xml:space="preserve">' +
        xmlEsc(tidy(sheet.subtitle || "")) +
        "</t></is></c></row>",
    );
    out.push('<row r="3"/>');

    out.push(rowXml(HEADER_ROW, headers, "header", 28));
    body.forEach(function (row, i) {
      out.push(rowXml(HEADER_ROW + 1 + i, row, "body"));
    });
    footer.forEach(function (row, i) {
      out.push(rowXml(HEADER_ROW + 1 + body.length + i, row, "footer"));
    });
    out.push("</sheetData>");

    if (body.length) {
      out.push(
        '<autoFilter ref="A' +
          HEADER_ROW +
          ":" +
          colRef(ncol - 1) +
          (HEADER_ROW + body.length) +
          '"/>',
      );
    }
    out.push("</worksheet>");
    return out.join("");
  }

  function stylesXml() {
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>' +
      '<fonts count="5">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="13"/><color rgb="FF084A82"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
      '<font><i/><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font>' +
      "</fonts>" +
      '<fills count="4">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF0B5FA5"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFF0F7FF"/><bgColor indexed="64"/></patternFill></fill>' +
      "</fills>" +
      '<borders count="2">' +
      "<border><left/><right/><top/><bottom/><diagonal/></border>" +
      '<border><left style="thin"><color rgb="FFE2E8F0"/></left>' +
      '<right style="thin"><color rgb="FFE2E8F0"/></right>' +
      '<top style="thin"><color rgb="FFE2E8F0"/></top>' +
      '<bottom style="thin"><color rgb="FFE2E8F0"/></bottom>' +
      "<diagonal/></border>" +
      "</borders>" +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="9">' +
      /* 0 plain  */ '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
      /* 1 bold   */ '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>' +
      /* 2 title  */ '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      /* 3 header */ '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
      /* 4 hl     */ '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>' +
      /* 5 hl bold*/ '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
      /* 6 pct    */ '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>' +
      /* 7 pct hl */ '<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' +
      /* 8 sub    */ '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      "</cellXfs>" +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>"
    );
  }

  /* ------------------------------------------------------------- ZIP (store) */

  function crc32(buf) {
    var c = 0xffffffff;
    for (var i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (var k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function zipBytes(files) {
    var enc = new TextEncoder();
    var now = new Date();
    var dosTime =
      (now.getHours() << 11) |
      (now.getMinutes() << 5) |
      (now.getSeconds() >> 1);
    var dosDate =
      ((now.getFullYear() - 1980) << 9) |
      ((now.getMonth() + 1) << 5) |
      now.getDate();

    var parts = [];
    var central = [];
    var offset = 0;

    files.forEach(function (file) {
      var nameBytes = enc.encode(file.name);
      var data =
        file.data instanceof Uint8Array ? file.data : enc.encode(file.data);
      var crc = crc32(data);

      var lh = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); /* UTF-8 names */
      lv.setUint16(8, 0, true); /* stored, no compression */
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      var ch = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);

      parts.push(lh, data);
      central.push(ch);
      offset += lh.length + data.length;
    });

    var cdSize = central.reduce(function (a, b) {
      return a + b.length;
    }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var all = parts.concat(central, [eocd]);
    var total = all.reduce(function (a, b) {
      return a + b.length;
    }, 0);
    var out = new Uint8Array(total);
    var pos = 0;
    all.forEach(function (chunk) {
      out.set(chunk, pos);
      pos += chunk.length;
    });
    return out;
  }

  /* ------------------------------------------------------------ workbook out */

  function buildXlsxBytes(sheets) {
    var list = (sheets || []).filter(Boolean);
    if (!list.length) return null;

    var used = {};
    var sheetTags = [];
    var sheetRels = [];

    list.forEach(function (s, i) {
      var nm = sheetName(s.name || s.title || "Table " + (i + 1));
      var base = nm;
      var k = 2;
      while (used[nm.toLowerCase()]) {
        nm = (base.slice(0, 27) + " " + k).slice(0, 31);
        k++;
      }
      used[nm.toLowerCase()] = 1;
      sheetTags.push(
        '<sheet name="' +
          xmlEsc(nm) +
          '" sheetId="' +
          (i + 1) +
          '" r:id="rId' +
          (i + 1) +
          '"/>',
      );
      sheetRels.push(
        '<Relationship Id="rId' +
          (i + 1) +
          '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
          (i + 1) +
          '.xml"/>',
      );
    });

    var styleRid = "rId" + (list.length + 1);
    sheetRels.push(
      '<Relationship Id="' +
        styleRid +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    );

    var contentTypes = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
      list
        .map(function (s, i) {
          return (
            '<Override PartName="/xl/worksheets/sheet' +
            (i + 1) +
            '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          );
        })
        .join(""),
      "</Types>",
    ].join("");

    var rootRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>";

    var workbook =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      "<sheets>" +
      sheetTags.join("") +
      "</sheets></workbook>";

    var workbookRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheetRels.join("") +
      "</Relationships>";

    var files = [
      { name: "[Content_Types].xml", data: contentTypes },
      { name: "_rels/.rels", data: rootRels },
      { name: "xl/workbook.xml", data: workbook },
      { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
      { name: "xl/styles.xml", data: stylesXml() },
    ];
    list.forEach(function (s, i) {
      files.push({
        name: "xl/worksheets/sheet" + (i + 1) + ".xml",
        data: worksheetXml(s),
      });
    });

    return zipBytes(files);
  }

  function buildXlsx(sheets) {
    var bytes = buildXlsxBytes(sheets);
    return bytes ? new Blob([bytes], { type: MIME_XLSX }) : null;
  }

  /* ------------------------------------------------------------- downloads  */

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1000);
  }

  function sheetFor(table) {
    var model = modelFromTable(table);
    if (!model) return null;
    var title = tableName(table);
    return {
      name: title,
      title: title,
      subtitle: tableSubtitle(table),
      headers: model.headers,
      body: model.body,
      footer: model.footer,
      highlight: model.highlight,
    };
  }

  /* Filenames carry the reporting period so two months never collide. */
  function exportBase(title) {
    var period = document.getElementById("period-select");
    var ps = "";
    if (period && /^\d{6}$/.test(period.value)) {
      ps = fmtYm(period.value).replace(/\s+/g, "");
    }
    return slug(title, 110) + (ps ? "_" + ps : "");
  }

  function exportTable(table, kind) {
    var sheet = sheetFor(table);
    if (!sheet) return;
    var base = exportBase(sheet.title);
    if (kind === "csv") {
      var csv = "\ufeff" + toCsv(sheet);
      saveBlob(
        new Blob([csv], { type: "text/csv;charset=utf-8" }),
        base + ".csv",
      );
    } else {
      var blob = buildXlsx([sheet]);
      if (blob) saveBlob(blob, base + ".xlsx");
    }
  }

  function visibleTables() {
    var all = document.querySelectorAll("table");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].offsetParent === null)
        continue; /* hidden tab / not rendered */
      if (all[i].closest(".table-toolbar")) continue;
      out.push(all[i]);
    }
    return out;
  }

  function exportAllTables() {
    var tables = visibleTables();
    if (!tables.length) return;
    var sheets = [];
    tables.forEach(function (t) {
      var s = sheetFor(t);
      if (s) sheets.push(s);
    });
    if (!sheets.length) return;
    var blob = buildXlsx(sheets);
    if (!blob) return;
    var page = document.title.split("\u2014")[0] || "tables";
    saveBlob(blob, slug(page, 40) + "_all-tables_" + timestamp() + ".xlsx");
  }

  /* --------------------------------------------------------------- the UI   */

  function decorate(table) {
    if (table.dataset.exportReady) return;
    if (!table.rows || !table.rows.length) return;
    table.dataset.exportReady = "1";

    var bar = document.createElement("div");
    bar.className = "table-toolbar";

    [
      { kind: "csv", label: "CSV", tip: "Download this table as a CSV file" },
      {
        kind: "xlsx",
        label: "Excel",
        tip: "Download this table as an Excel workbook",
      },
    ].forEach(function (spec) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tt-btn";
      btn.dataset.kind = spec.kind;
      btn.title = spec.tip;
      btn.textContent = ICON + " " + spec.label;
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        exportTable(table, spec.kind);
      });
      bar.appendChild(btn);
    });

    var parent = table.parentElement;
    if (
      parent &&
      (parent.classList.contains("table-scroll") ||
        parent.classList.contains("fac-scroll"))
    ) {
      /* keep the toolbar outside the scrolling box */
      parent.parentNode.insertBefore(bar, parent);
    } else if (parent) {
      parent.insertBefore(bar, table);
    } else {
      return;
    }
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.tagName === "TABLE") decorate(root);
    var found = root.querySelectorAll ? root.querySelectorAll("table") : [];
    for (var i = 0; i < found.length; i++) decorate(found[i]);
  }

  function injectAllButton() {
    if (document.getElementById("table-export-all")) return;
    if (document.querySelectorAll("table").length < 2) return;
    var host =
      document.querySelector(".filter-actions") ||
      document.querySelector(".filter-meta") ||
      document.querySelector(".header-inner");
    if (!host) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "table-export-all";
    btn.className = "btn btn-ghost";
    btn.title = "Download every table on this page as one Excel workbook";
    btn.textContent = ICON + " All tables";
    btn.addEventListener("click", exportAllTables);
    host.appendChild(btn);
  }

  function boot() {
    scan(document.body);
    injectAllButton();
    var mo = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) scan(added[j]);
      }
      injectAllButton();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  var api = {
    csv: toCsv,
    xlsxBytes: buildXlsxBytes,
    buildXlsx: buildXlsx,
    model: modelFromTable,
    sheetFor: sheetFor,
    fileName: exportBase,
    downloadTable: exportTable,
    downloadAllTables: exportAllTables,
    slug: slug,
  };

  if (global) global.TableExport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
