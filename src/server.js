const express = require('express');
const multer = require('multer');
const fse = require('fs-extra');
const path = require('path');
const { execFile } = require('child_process');
const { exec } = require('child-process-promise');
const util = require('util');
const moment = require('moment');
const tmp = require('tmp-promise');

const app = express();
const upload = multer({ 
  dest: 'uploads/', 
  limits: { fileSize: 15 * 1024 * 1024 }
});

const DATA = path.join(__dirname, '../data');
const TIDE = 'tide';
const PCAL = 'pcal';
const CONVERT = 'convert';
const COMPOSITE = 'composite';
const GS = 'gs';

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const execFilePromise = util.promisify(execFile);

app.post('/api/nearest', async (req, res) => {
  console.log('\n=== /api/nearest HIT ===');
  console.log('Raw req.body →', req.body);

  let lat = req.body?.lat ?? req.body?.latitude;
  let lng = req.body?.lng ?? req.body?.lon ?? req.body?.longitude;

  console.log('Parsed lat →', lat, 'lng →', lng);

  if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
    console.log('Bad coordinates → 400');
    return res.status(400).json({ error: 'Invalid coordinates', received: req.body });
  }

  console.log(`Good coords → ${lat.toFixed(6)}, ${lng.toFixed(6)} – calling Python`);

  try {
    const py = path.join(__dirname, 'nearest_tide.py');
    const { stdout, stderr } = await execFilePromise('python3', [
      py,
      lat.toString(),
      lng.toString()
    ], { timeout: 20000 });

    if (stderr) console.log('Python stderr:', stderr.trim());
    console.log('Python success – raw JSON:', stdout.trim());

    const stations = JSON.parse(stdout);
    console.log(`Returned ${stations.length} stations. Best:`, stations[0]?.name);
    res.json(stations);

  } catch (err) {
    console.error('nearest_tide.py FAILED');
    console.error('Message:', err.message);
    console.error('stderr:', err.stderr?.toString());
    res.status(500).json({ error: 'Python script failed', details: err.message });
  }
});

app.post('/generate', upload.single('background'), async (req, res) => {
  let tmpDir;
  try {
    tmpDir = await tmp.dir({ unsafeCleanup: true });
    const dir = tmpDir.path;

    const {
      startMonth,
      startYear,
      station,
      customText = '',
      options = []
    } = req.body;

    const opts = {
      language: options.includes('language'),
      tide:     options.includes('tide'),
      sun:      options.includes('sun'),
      moon:     options.includes('moon'),
      mahina:   options.includes('mahina'),
      holidays: options.includes('holidays'),
      custom:   options.includes('custom')
    };

    const start = `${startYear}-${startMonth.padStart(2, '0')}-01 00:00`;
    const end = moment(start).add(1, 'month').format('YYYY-MM-DD 00:00');

let tideLines  = [];
let sunLines   = [];
let moonLines  = [];
let tideRawLines = [];
let sunRawLines  = [];
let moonRawLines = [];

if (station) {
  const run = async (prefix, emMask) => {
    const cmd = `${TIDE} -b "${start}" -e "${end}" -l "${station}" -df %m/%d/%Y -tf ${prefix}:%l:%M%p -em ${emMask}`;
    const { stdout } = await exec(cmd);
    return stdout.trim().split('\n');
  };

  try {
    tideRawLines = opts.tide ? await run('tidedata', 'pSsMm') : [];
    sunRawLines  = opts.sun  ? await run('sundata',  'pMm')   : [];
    moonRawLines = opts.moon ? await run('moondata', 'Ss')   : [];

    if (opts.tide) {
      for (let l of tideRawLines) {
        if (!l.includes('tidedata:')) continue;
        let p = l.trim();
        p = p.replace('tidedata:', p.includes('High') ? 'tidedata:\\056hightide ' : 'tidedata:\\056lowtide ');
        p = p.replace(/High Tide/gi, 'H').replace(/Low Tide/gi, 'L').replace(' feet', '').replace(/,\s*/g, ' ').trim();
        if (/\bknots\b/i.test(l)) continue;
        tideLines.push(p);
      }
    }

    if (opts.sun) {
      for (let l of sunRawLines) {
        if (/\bTide\b/i.test(l)) continue;
        if (/\bknots\b/i.test(l)) continue;
        if (!l.includes('sundata:')) continue;
        sunLines.push(l.trim().replace('Sunrise', 'SR').replace('Sunset', 'SS'));
      }
    }

    if (opts.moon) {
      for (let l of moonRawLines) {
        if (/\bTide\b/i.test(l)) continue;
        if (/\bknots\b/i.test(l)) continue;
        if (!l.includes('moondata:')) continue;
        moonLines.push(l.trim()
          .replace('Moonrise', 'MR')
          .replace('Moonset', 'MS')
          .replace('New Moon', 'NM')
          .replace('Full Moon', 'FM')
          .replace('First Quarter', 'FQ')
          .replace('Last Quarter', 'LQ')
        );
      }
    }
  } catch (err) {
    console.error('Error fetching astronomical/tide data:', err);
    tideLines = sunLines = moonLines = [];
  }
} 

    await fse.copy(path.join(DATA, 'calendar.dat'),     path.join(dir, 'calendar.dat'));
    await fse.copy(path.join(DATA, 'mahina.dat'),      path.join(dir, 'mahina.dat'));
    await fse.copy(path.join(DATA, 'mahina.def'),      path.join(dir, 'mahina.def'));
    await fse.copy(path.join(DATA, 'calendar_us.txt'), path.join(dir, 'calendar_us.txt'));
    await fse.copy(path.join(DATA, 'mask.png'),        path.join(dir, 'mask.png'));
    await fse.writeFile(path.join(dir, 'tide.dat'), tideLines.join('\n') + '\n');
    await fse.writeFile(path.join(dir, 'sun.dat'),  sunLines.join('\n') + '\n');
    await fse.writeFile(path.join(dir, 'moon.dat'), moonLines.join('\n') + '\n');

    let customContent = (customText || '').trim();
    if (opts.custom && customContent) {
      const lines = customContent.split('\n');
      for (const line of lines) if (line.includes('_def')) customContent += '\n' + line.replace('_def', '_def_2');
    }
    await fse.writeFile(path.join(dir, 'custom.dat'), customContent + '\n');

    let include = opts.language ? 'opt -a ha\n' : 'opt -a en -r Latin4\n';

    if (customContent.includes('def oahu_def')) {
     include += 'def oahu_def\n';
    } else {
     include += 'def big_island_def\n';
    }

    if (opts.mahina) include += 'include mahina.dat\n';
    include += 'include mahina.def.dat\n';
    if (opts.holidays) include += 'include calendar_us.txt\n';
    if (opts.tide) include += 'include tide.dat\n';
    if (opts.sun) include += 'include sun.dat\n';
    if (opts.moon) include += 'include moon.dat\n';
    if (opts.custom) include += 'include custom.dat\n';
    await fse.writeFile(path.join(dir, 'include.dat'), include);

    const prevYear = (parseInt(startYear) - 1).toString();
    const { stdout: defOut } = await exec(`${PCAL} -o /dev/null -f ${path.join(dir, 'mahina.def')} -ZT ${startMonth} ${prevYear} 36`);
    let defs = '';
    for (const line of defOut.split('\n')) {
      if (/^\d/.test(line.trim())) {
        const date = line.substring(0, 10);
        const name = line.substring(12).trim();
        if (name) defs += `def ${defs.includes(name) ? name + '_2' : name} ${date}\n`;
      }
    }
    await fse.writeFile(path.join(dir, 'mahina.def.dat'), defs);

    await exec(`${PCAL} -f ${path.join(dir, 'calendar.dat')} -o ${path.join(dir, 'mahina.ps')} ${startMonth} ${startYear} 1`);

    let hasBackground = false;
    if (req.file && req.file.path && await fse.pathExists(req.file.path)) {
      hasBackground = true;
      console.log(`Using background: ${req.file.originalname}`);
      await fse.copy(req.file.path, path.join(dir, 'userbg.jpg'));

      await exec(`${CONVERT} -transparent white -rotate 90 -density 300 "${path.join(dir, 'mahina.ps')}" "${path.join(dir, 'mahina.png')}"`);
      await exec(`${CONVERT} -sample 3300x5100 -crop 3300x5100+0+0 -quality 85 "${path.join(dir, 'userbg.jpg')}" "${path.join(dir, 'bg.jpg')}"`);
      await exec(`${COMPOSITE} -compose src-over "${path.join(dir, 'mask.png')}" "${path.join(dir, 'bg.jpg')}" "${path.join(dir, 'bg_masked.jpg')}"`);
      await exec(`${COMPOSITE} -compose src-over "${path.join(dir, 'mahina.png')}" "${path.join(dir, 'bg_masked.jpg')}" "${path.join(dir, 'mahina.png')}"`);
      await exec(`${GS} -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOutputFile="${path.join(dir, 'mahina.pdf')}" "${path.join(dir, 'mahina.ps')}"`);
    } else {
      await exec(`${GS} -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOutputFile="${path.join(dir, 'mahina.pdf')}" "${path.join(dir, 'mahina.ps')}"`);
      await exec(`${CONVERT} -density 300 -rotate 90 "${path.join(dir, 'mahina.ps')}" "${path.join(dir, 'mahina.png')}"`);
    }

    const base = `/tmp/${path.basename(dir)}`;
    app.use(base, express.static(dir));

    res.send(`
      <h2>Hawaiian Moon & Tide Calendar</h2>
      <p>
        <a href="${base}/mahina.ps" target="_blank">PostScript</a> • 
        <a href="${base}/mahina.pdf" target="_blank">PDF</a> • 
        <a href="${base}/mahina.png" target="_blank">PNG</a>
      </p>
      <p>Mahalo nui loa.</p>
    `);

    setTimeout(() => tmpDir.cleanup().catch(() => {}), 10 * 60 * 1000);

  } catch (err) {
    console.error('ERROR:', err);
    res.status(500).send(`<pre>${err.message}\n\n${err.stack}</pre>`);
    if (tmpDir) tmpDir.cleanup().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Final working Hawaiian Calendar → http://localhost:${PORT}`);
});
