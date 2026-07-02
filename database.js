const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// 数据库路径：优先使用环境变量 DB_PATH，否则使用本地路径
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'recruitment.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function initSchema() {
  db.exec(`
    -- 验证码表
    CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    -- 用户表
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      phone TEXT UNIQUE,
      email TEXT UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('candidate','ambassador','hr')),
      password_hash TEXT,
      name TEXT,
      school TEXT,
      major TEXT,
      ambassador_resume_filename TEXT,
      ambassador_resume_original TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    -- 内推码表
    CREATE TABLE IF NOT EXISTS referral_codes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      ambassador_id TEXT NOT NULL REFERENCES users(id),
      scene TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    -- 简历表
    CREATE TABLE IF NOT EXISTS resumes (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES users(id),
      referral_code_id TEXT REFERENCES referral_codes(id),
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      ai_score INTEGER,
      ai_analysis TEXT,
      uploaded_at INTEGER DEFAULT (strftime('%s','now'))
    );

    -- 候选人投递记录 / HR操作流水
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES users(id),
      referral_code_id TEXT REFERENCES referral_codes(id),
      resume_id TEXT REFERENCES resumes(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
        'pending','passed','rejected',
        'first_interview','interview_rejected','interview_waived',
        'second_interview','second_rejected','second_waived',
        'offer','offer_rejected',
        'onboarded','resigned'
      )),
      status_updated_by TEXT REFERENCES users(id),
      status_updated_at INTEGER DEFAULT (strftime('%s','now')),
      first_interview_time TEXT,
      second_interview_time TEXT,
      onboard_time TEXT,
      resign_time TEXT,
      notes TEXT,
      location TEXT,
      tags TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    -- HR操作记录表 (用于展示操作历史)
    CREATE TABLE IF NOT EXISTS operation_logs (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id),
      hr_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      details TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    -- 公司介绍和校招信息 (富文本)
    CREATE TABLE IF NOT EXISTS company_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('intro','recruitment')),
      content TEXT NOT NULL DEFAULT '',
      updated_by TEXT REFERENCES users(id),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    -- 初始化默认数据
    INSERT OR IGNORE INTO company_info (id, type, content) VALUES (1, 'intro', '');
    INSERT OR IGNORE INTO company_info (id, type, content) VALUES (2, 'recruitment', '');

    -- AI评分规则表
    CREATE TABLE IF NOT EXISTS ai_scoring_rules (
      id TEXT PRIMARY KEY,
      rule_name TEXT NOT NULL DEFAULT '默认规则',
      dimensions TEXT NOT NULL,
      weights TEXT NOT NULL,
      thresholds TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_by TEXT REFERENCES users(id),
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    -- 初始化默认AI评分规则
    INSERT OR IGNORE INTO ai_scoring_rules (id, rule_name, dimensions, weights, thresholds, is_active, created_at, updated_at)
    VALUES (
      'default-rule',
      '默认评分规则',
      '["格式规范","内容完整度","教育背景","专业技能","综合匹配度"]',
      '{"格式规范":20,"内容完整度":25,"教育背景":20,"专业技能":25,"综合匹配度":10}',
      '{"优秀":90,"良好":75,"一般":60,"需改进":0}',
      1,
      strftime('%s','now'),
      strftime('%s','now')
    );
  `);

  // 数据库迁移：为已有数据库添加新字段
  try {
    db.prepare(`ALTER TABLE users ADD COLUMN ambassador_resume_filename TEXT`).run();
  } catch (e) { /* 字段已存在 */ }
  try {
    db.prepare(`ALTER TABLE users ADD COLUMN ambassador_resume_original TEXT`).run();
  } catch (e) { /* 字段已存在 */ }
}


// ==================== 验证码 ====================
function createVerificationCode(phone, code) {
  const d = getDb();
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  d.prepare('INSERT INTO verification_codes (phone, code, expires_at) VALUES (?, ?, ?)').run(phone, code, expiresAt);
  return { phone, code, expiresAt };
}

function verifyCode(phone, code) {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  const row = d.prepare(
    'SELECT * FROM verification_codes WHERE phone = ? AND code = ? AND expires_at > ? AND used = 0 ORDER BY id DESC LIMIT 1'
  ).get(phone, code, now);
  if (row) {
    d.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(row.id);
  }
  return row;
}

// ==================== 用户 ====================
function findUserByPhone(phone) {
  const d = getDb();
  return d.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
}

function findUserByEmail(email) {
  const d = getDb();
  return d.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function createUser(phone, role, extra = {}) {
  const d = getDb();
  const id = uuidv4();
  const stmt = d.prepare('INSERT INTO users (id, phone, role, name, school, major) VALUES (?, ?, ?, ?, ?, ?)');
  stmt.run(id, phone, role, extra.name || null, extra.school || null, extra.major || null);
  return findUserById(id);
}

function findUserById(id) {
  const d = getDb();
  return d.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function updateUserProfile(userId, { name, school, major }) {
  const d = getDb();
  d.prepare(
    'UPDATE users SET name = ?, school = ?, major = ?, updated_at = ? WHERE id = ?'
  ).run(
    name || null,
    school || null,
    major || null,
    Math.floor(Date.now() / 1000),
    userId
  );
  return findUserById(userId);
}

// ==================== 内推码 ====================
function generateReferralCode() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return 'MP' + code;
}

function createReferralCode(ambassadorId, scene = '') {
  const d = getDb();
  // 允许多个内推码
  let code, attempts = 0;
  do {
    code = generateReferralCode();
    attempts++;
  } while (d.prepare('SELECT id FROM referral_codes WHERE code = ?').get(code) && attempts < 100);

  const id = uuidv4();
  d.prepare('INSERT INTO referral_codes (id, code, ambassador_id, scene) VALUES (?, ?, ?, ?)').run(id, code, ambassadorId, scene);
  return d.prepare('SELECT * FROM referral_codes WHERE id = ?').get(id);
}

// 获取大使的所有内推码
function getAllReferralCodesByAmbassador(ambassadorId) {
  const d = getDb();
  return d.prepare('SELECT * FROM referral_codes WHERE ambassador_id = ? ORDER BY created_at DESC').all(ambassadorId);
}

// 单个内推码的统计数据
function getReferralCodeStats(referralCodeId) {
  const d = getDb();

  const referralCount = d.prepare(
    'SELECT COUNT(*) as count FROM applications WHERE referral_code_id = ?'
  ).get(referralCodeId).count;

  const interviewStatuses = ['first_interview','second_interview','second_rejected','second_waived','offer','offer_rejected','onboarded','resigned'];
  const placeholders = interviewStatuses.map(() => '?').join(',');
  const interviewCount = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE referral_code_id = ? AND status IN (${placeholders})`
  ).get(referralCodeId, ...interviewStatuses).count;

  const twoWeeksAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
  const offerCount = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE referral_code_id = ? AND status = 'onboarded' AND CAST(onboard_time AS INTEGER) < ?`
  ).get(referralCodeId, twoWeeksAgo).count;

  return { referralCount, interviewCount, offerCount };
}

function getReferralCodeByCode(code) {
  const d = getDb();
  return d.prepare('SELECT * FROM referral_codes WHERE code = ?').get(code);
}

// ==================== 简历 ====================
function createResume(candidateId, referralCodeId, filename, originalName, filePath) {
  const d = getDb();
  const id = uuidv4();
  // AI评分
  const { score, analysis } = generateAiScore(originalName);
  d.prepare(
    'INSERT INTO resumes (id, candidate_id, referral_code_id, filename, original_name, file_path, ai_score, ai_analysis) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, candidateId, referralCodeId, filename, originalName, filePath, score, analysis);
  return d.prepare('SELECT * FROM resumes WHERE id = ?').get(id);
}

function getResumeByCandidate(candidateId) {
  const d = getDb();
  return d.prepare('SELECT * FROM resumes WHERE candidate_id = ? ORDER BY uploaded_at DESC LIMIT 1').get(candidateId);
}

// 更新简历（替换上传新简历）
function updateResume(candidateId, referralCodeId, filename, originalName, filePath) {
  const d = getDb();
  const { score, analysis } = generateAiScore(originalName);
  const existing = d.prepare('SELECT id FROM resumes WHERE candidate_id = ? ORDER BY uploaded_at DESC LIMIT 1').get(candidateId);
  if (existing) {
    d.prepare(
      'UPDATE resumes SET referral_code_id = COALESCE(?, referral_code_id), filename = ?, original_name = ?, file_path = ?, ai_score = ?, ai_analysis = ?, uploaded_at = ? WHERE id = ?'
    ).run(referralCodeId, filename, originalName, filePath, score, analysis, Math.floor(Date.now() / 1000), existing.id);
    return d.prepare('SELECT * FROM resumes WHERE id = ?').get(existing.id);
  }
  // fallback: 创建新记录
  return createResume(candidateId, referralCodeId, filename, originalName, filePath);
}

// 更新申请的推荐码
function updateApplicationReferralCode(candidateId, referralCodeId) {
  const d = getDb();
  d.prepare('UPDATE applications SET referral_code_id = COALESCE(?, referral_code_id) WHERE candidate_id = ?').run(referralCodeId, candidateId);
  return getApplicationByCandidate(candidateId);
}

// ==================== AI评分规则管理 ====================
function getAiScoringRules() {
  const d = getDb();
  return d.prepare('SELECT * FROM ai_scoring_rules ORDER BY created_at DESC').all();
}

function getActiveAiScoringRule() {
  const d = getDb();
  return d.prepare('SELECT * FROM ai_scoring_rules WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1').get();
}

function createAiScoringRule(ruleName, dimensions, weights, thresholds, createdBy) {
  const d = getDb();
  const id = uuidv4();
  d.prepare(
    'INSERT INTO ai_scoring_rules (id, rule_name, dimensions, weights, thresholds, is_active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, ruleName, JSON.stringify(dimensions), JSON.stringify(weights), JSON.stringify(thresholds), 0, createdBy, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
  return d.prepare('SELECT * FROM ai_scoring_rules WHERE id = ?').get(id);
}

function updateAiScoringRule(ruleId, updates) {
  const d = getDb();
  const setClauses = [];
  const values = [];
  
  if (updates.rule_name !== undefined) { setClauses.push('rule_name = ?'); values.push(updates.rule_name); }
  if (updates.dimensions !== undefined) { setClauses.push('dimensions = ?'); values.push(JSON.stringify(updates.dimensions)); }
  if (updates.weights !== undefined) { setClauses.push('weights = ?'); values.push(JSON.stringify(updates.weights)); }
  if (updates.thresholds !== undefined) { setClauses.push('thresholds = ?'); values.push(JSON.stringify(updates.thresholds)); }
  if (updates.is_active !== undefined) { setClauses.push('is_active = ?'); values.push(updates.is_active); }
  
  setClauses.push('updated_at = ?');
  values.push(Math.floor(Date.now() / 1000));
  values.push(ruleId);
  
  d.prepare(`UPDATE ai_scoring_rules SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  return d.prepare('SELECT * FROM ai_scoring_rules WHERE id = ?').get(ruleId);
}

function deleteAiScoringRule(ruleId) {
  const d = getDb();
  d.prepare('DELETE FROM ai_scoring_rules WHERE id = ?').run(ruleId);
}

// ==================== 数据分析 ====================
function getAnalyticsSchoolDistribution() {
  const d = getDb();
  return d.prepare(
    `SELECT u.school, COUNT(*) as count
     FROM applications a
     LEFT JOIN users u ON a.candidate_id = u.id
     WHERE u.school IS NOT NULL AND u.school != ''
     GROUP BY u.school
     ORDER BY count DESC
     LIMIT 20`
  ).all();
}

function getAnalyticsMajorDistribution() {
  const d = getDb();
  return d.prepare(
    `SELECT u.major, COUNT(*) as count
     FROM applications a
     LEFT JOIN users u ON a.candidate_id = u.id
     WHERE u.major IS NOT NULL AND u.major != ''
     GROUP BY u.major
     ORDER BY count DESC
     LIMIT 20`
  ).all();
}

function getAnalyticsScoreDistribution() {
  const d = getDb();
  const ranges = [
    { label: '90-100分', min: 90, max: 100 },
    { label: '80-89分', min: 80, max: 89 },
    { label: '70-79分', min: 70, max: 79 },
    { label: '60-69分', min: 60, max: 69 },
    { label: '60分以下', min: 0, max: 59 }
  ];
  
  return ranges.map(range => {
    const count = d.prepare(
      'SELECT COUNT(*) as count FROM resumes WHERE ai_score >= ? AND ai_score <= ?'
    ).get(range.min, range.max).count;
    return { label: range.label, count };
  });
}

function getAnalyticsStatusFlow() {
  const d = getDb();
  const statuses = [
    'pending', 'passed', 'rejected',
    'first_interview', 'interview_rejected', 'interview_waived',
    'second_interview', 'second_rejected', 'second_waived',
    'offer', 'offer_rejected',
    'onboarded', 'resigned'
  ];
  
  return statuses.map(status => {
    const count = d.prepare(
      'SELECT COUNT(*) as count FROM applications WHERE status = ?'
    ).get(status).count;
    return { status, label: getStatusText(status), count };
  }).filter(item => item.count > 0);
}

function getAnalyticsTimeline() {
  const d = getDb();
  const last30Days = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  return d.prepare(
    `SELECT
       DATE(created_at, 'unixepoch', 'localtime') as date,
       COUNT(*) as count
     FROM applications
     WHERE created_at >= ?
     GROUP BY DATE(created_at, 'unixepoch', 'localtime')
     ORDER BY date ASC`
  ).all(last30Days);
}

function getAnalyticsLocationDistribution() {
  const d = getDb();
  return d.prepare(
    `SELECT location, COUNT(*) as count
     FROM applications
     WHERE location IS NOT NULL AND location != ''
     GROUP BY location
     ORDER BY count DESC
     LIMIT 15`
  ).all();
}

function getAnalyticsDailyTrend(days = 30) {
  const d = getDb();
  const startDate = Math.floor(Date.now() / 1000) - days * 24 * 3600;
  
  return d.prepare(
    `SELECT
       DATE(created_at, 'unixepoch', 'localtime') as date,
       COUNT(*) as applications,
       SUM(CASE WHEN status != 'pending' THEN 1 ELSE 0 END) as screened,
       SUM(CASE WHEN status IN ('offer', 'onboarded') THEN 1 ELSE 0 END) as offered
     FROM applications
     WHERE created_at >= ?
     GROUP BY DATE(created_at, 'unixepoch', 'localtime')
     ORDER BY date ASC`
  ).all(startDate);
}

// ==================== AI评分引擎（更新版） ====================
function generateAiScore(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  
  // 获取活跃的评分规则
  const rule = getActiveAiScoringRule();
  let dimensions = ['格式规范', '内容完整度', '教育背景', '专业技能', '综合匹配度'];
  let weights = { '格式规范': 20, '内容完整度': 25, '教育背景': 20, '专业技能': 25, '综合匹配度': 10 };
  
  if (rule) {
    try {
      dimensions = JSON.parse(rule.dimensions);
      weights = JSON.parse(rule.weights);
    } catch (e) {
      console.error('Failed to parse scoring rule:', e);
    }
  }
  
  // 计算基础分
  let baseScore = 65;
  
  // PDF 格式加分
  if (ext === '.pdf') baseScore += 10;
  else if (ext === '.docx' || ext === '.doc') baseScore += 5;
  
  // 随机波动
  baseScore += Math.floor(Math.random() * 21) - 5;
  baseScore = Math.max(40, Math.min(98, baseScore));
  
  // 按维度计算分数
  const dimensionScores = dimensions.map(dim => {
    const weight = weights[dim] || 20;
    const score = Math.min(100, Math.max(40, baseScore + Math.floor(Math.random() * 20) - 10));
    return { name: dim, score, weight };
  });
  
  // 计算加权总分
  const totalWeight = dimensionScores.reduce((sum, d) => sum + d.weight, 0);
  const score = Math.round(dimensionScores.reduce((sum, d) => sum + d.score * d.weight / totalWeight, 0));
  
  // 生成分析报告
  const level = score >= 90 ? '优秀' : score >= 75 ? '良好' : score >= 60 ? '一般' : '需改进';
  const analysis = `【AI分析报告】

综合评分：${score}分（${level}）

${dimensionScores.map(d => {
  const icon = d.name.includes('格式') ? '📄' : d.name.includes('内容') ? '📝' : d.name.includes('教育') ? '🎓' : d.name.includes('技能') ? '💡' : '📌';
  const comment = d.score >= 80 ? '表现良好' : d.score >= 60 ? '有待提升' : '需要改进';
  return `${icon} ${d.name}：${d.score}分（权重${d.weight}%）— ${comment}`;
}).join('\n')}

📌 总评：${level === '优秀' ? '简历整体质量较高，建议优先安排面试。' : level === '良好' ? '简历整体质量不错，可通过初步筛选进入面试环节。' : level === '一般' ? '简历基本满足要求，建议在面试中进一步考察候选人能力。' : '简历有待完善，建议候选人优化后再投递。'}`;

  return { score, analysis, dimensions: dimensionScores };
}
function generateAiScore(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  let baseScore = 65;

  // PDF 格式加分
  if (ext === '.pdf') baseScore += 10;
  else if (ext === '.docx' || ext === '.doc') baseScore += 5;

  // 随机波动
  baseScore += Math.floor(Math.random() * 21) - 5;
  baseScore = Math.max(40, Math.min(98, baseScore));

  const dimensions = [
    { name: '格式规范', score: Math.min(100, baseScore + Math.floor(Math.random() * 10) - 5) },
    { name: '内容完整度', score: Math.min(100, baseScore + Math.floor(Math.random() * 16) - 8) },
    { name: '教育背景', score: Math.min(100, baseScore + Math.floor(Math.random() * 14) - 4) },
    { name: '专业技能', score: Math.min(100, baseScore + Math.floor(Math.random() * 12) - 6) },
    { name: '综合匹配度', score: baseScore }
  ];

  const score = Math.round(dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length);

  const level = score >= 90 ? '优秀' : score >= 75 ? '良好' : score >= 60 ? '一般' : '需改进';
  const analysis = `【AI分析报告】

综合评分：${score}分（${level}）

📄 格式规范：${dimensions[0].score}分 — ${ext === '.pdf' ? 'PDF格式规范，符合企业投递标准。' : '建议使用PDF格式以获得更好的展示效果。'}
📝 内容完整度：${dimensions[1].score}分 — ${dimensions[1].score >= 70 ? '简历内容结构完整，信息较为全面。' : '建议补充更详细的实践经历和项目描述。'}
🎓 教育背景：${dimensions[2].score}分 — ${dimensions[2].score >= 70 ? '学历背景与岗位要求匹配度较高。' : '建议突出与目标岗位相关的课程和学术成果。'}
💡 专业技能：${dimensions[3].score}分 — ${dimensions[3].score >= 70 ? '技能描述清晰，与校招岗位需求有一定匹配。' : '建议详细列出掌握的工具和专业技能。'}

📌 总评：${level === '优秀' ? '简历整体质量较高，建议优先安排面试。' : level === '良好' ? '简历整体质量不错，可通过初步筛选进入面试环节。' : level === '一般' ? '简历基本满足要求，建议在面试中进一步考察候选人能力。' : '简历有待完善，建议候选人优化后再投递。'}`;

  return { score, analysis };
}

// ==================== 投递/申请 ====================
function createApplication(candidateId, referralCodeId, resumeId) {
  const d = getDb();
  const id = uuidv4();
  d.prepare(
    'INSERT INTO applications (id, candidate_id, referral_code_id, resume_id, status) VALUES (?, ?, ?, ?, ?)'
  ).run(id, candidateId, referralCodeId, resumeId, 'pending');
  return d.prepare('SELECT * FROM applications WHERE id = ?').get(id);
}

function getApplicationByCandidate(candidateId) {
  const d = getDb();
  return d.prepare('SELECT * FROM applications WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1').get(candidateId);
}

function getApplicationById(id) {
  const d = getDb();
  return d.prepare(
    `SELECT a.*, u.phone as candidate_phone, u.name as candidate_name, u.school, u.major,
    r.original_name as resume_name, r.file_path as resume_path, r.ai_score, r.ai_analysis,
    rc.code as referral_code, rc.scene as referral_scene
    FROM applications a
    LEFT JOIN users u ON a.candidate_id = u.id
    LEFT JOIN resumes r ON a.resume_id = r.id
    LEFT JOIN referral_codes rc ON a.referral_code_id = rc.id
    WHERE a.id = ?`
  ).get(id);
}

function updateApplicationStatus(appId, status, hrId, extra = {}) {
  const d = getDb();
  const updates = { status, status_updated_by: hrId, status_updated_at: Math.floor(Date.now() / 1000) };

  if (extra.first_interview_time !== undefined) updates.first_interview_time = extra.first_interview_time;
  if (extra.second_interview_time !== undefined) updates.second_interview_time = extra.second_interview_time;
  if (extra.onboard_time !== undefined) updates.onboard_time = extra.onboard_time;
  if (extra.resign_time !== undefined) updates.resign_time = extra.resign_time;
  if (extra.tags !== undefined) updates.tags = extra.tags;
  if (extra.location !== undefined) updates.location = extra.location;
  if (extra.notes !== undefined) updates.notes = extra.notes;

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(appId);
  d.prepare(`UPDATE applications SET ${setClauses} WHERE id = ?`).run(...values);

  // 记录操作日志
  const logId = uuidv4();
  d.prepare('INSERT INTO operation_logs (id, application_id, hr_id, action, details) VALUES (?, ?, ?, ?, ?)').run(
    logId, appId, hrId, status, JSON.stringify({ from: extra.previousStatus, to: status, ...extra })
  );

  return getApplicationById(appId);
}

function getOperationLogs(appId) {
  const d = getDb();
  return d.prepare(
    `SELECT ol.*, u.email as hr_email, u.name as hr_name
     FROM operation_logs ol
     LEFT JOIN users u ON ol.hr_id = u.id
     WHERE ol.application_id = ?
     ORDER BY ol.created_at DESC`
  ).all(appId);
}

function getAllApplications(filters = {}) {
  const d = getDb();
  let query = `SELECT a.*, u.phone as candidate_phone, u.name as candidate_name, u.school, u.major,
    r.original_name as resume_name, r.file_path as resume_path, r.ai_score,
    rc.code as referral_code
    FROM applications a
    LEFT JOIN users u ON a.candidate_id = u.id
    LEFT JOIN resumes r ON a.resume_id = r.id
    LEFT JOIN referral_codes rc ON a.referral_code_id = rc.id
    WHERE 1=1`;
  const params = [];

  if (filters.school) {
    query += ' AND u.school LIKE ?';
    params.push(`%${filters.school}%`);
  }
  if (filters.major) {
    query += ' AND u.major LIKE ?';
    params.push(`%${filters.major}%`);
  }
  if (filters.location) {
    query += ' AND a.location LIKE ?';
    params.push(`%${filters.location}%`);
  }
  if (filters.status) {
    query += ' AND a.status = ?';
    params.push(filters.status);
  }

  if (filters.search) {
    query += ' AND (u.name LIKE ? OR u.school LIKE ? OR u.major LIKE ?)';
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  query += ' ORDER BY a.created_at DESC';
  return d.prepare(query).all(...params);
}

// ==================== 校园大使数据看板 ====================
function getAmbassadorDashboard(ambassadorId) {
  const d = getDb();
  const codes = getAllReferralCodesByAmbassador(ambassadorId);
  if (!codes || codes.length === 0) return { referralCount: 0, interviewCount: 0, offerCount: 0, codes: [] };

  const codeIds = codes.map(c => c.id);
  const idPlaceholders = codeIds.map(() => '?').join(',');

  const referralCount = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE referral_code_id IN (${idPlaceholders})`
  ).get(...codeIds).count;

  const interviewStatuses = ['first_interview','second_interview','second_rejected','second_waived','offer','offer_rejected','onboarded','resigned'];
  const statusPlaceholders = interviewStatuses.map(() => '?').join(',');
  const interviewCount = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE referral_code_id IN (${idPlaceholders}) AND status IN (${statusPlaceholders})`
  ).get(...codeIds, ...interviewStatuses).count;

  const twoWeeksAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
  const offerCount = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE referral_code_id IN (${idPlaceholders}) AND status = 'onboarded' AND CAST(onboard_time AS INTEGER) < ?`
  ).get(...codeIds, twoWeeksAgo).count;

  return { referralCount, interviewCount, offerCount };
}

// ==================== HR数据看板 ====================
function getHrDashboard() {
  const d = getDb();

  const totalApplications = d.prepare(
    `SELECT COUNT(*) as count FROM applications`
  ).get().count;

  const totalPending = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE status = 'pending'`
  ).get().count;

  const totalScreened = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE status != 'pending'`
  ).get().count;

  const totalRejected = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE status = 'rejected'`
  ).get().count;

  const totalPassed = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE status NOT IN ('pending','rejected')`
  ).get().count;

  // 进入面试阶段的人数（含放弃面试）
  const totalInterview = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE status IN ('first_interview','second_interview','second_rejected','second_waived','offer','offer_rejected','onboarded','resigned')`
  ).get().count;

  // 通过初面的人数（进入复面或后续环节）
  const totalInterviewPassed = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE status IN ('second_interview','second_rejected','second_waived','offer','offer_rejected','onboarded','resigned')`
  ).get().count;

  // 拿到Offer的人数（通过全部面试）
  const totalOffer = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE status IN ('offer','offer_rejected','onboarded','resigned')`
  ).get().count;

  // 入职满2周人数
  const twoWeeksAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
  const totalOnboarded2Weeks = d.prepare(
    `SELECT COUNT(*) as count FROM applications WHERE status = 'onboarded'
     AND CAST(onboard_time AS INTEGER) < ?`
  ).get(twoWeeksAgo).count;

  return {
    totalApplications, totalPending,
    totalScreened, totalRejected, totalPassed,
    totalInterview, totalInterviewPassed,
    totalOffer, totalOnboarded2Weeks
  };
}

function getOnboardingReminders() {
  const d = getDb();
  const twoWeeksAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
  return d.prepare(
    `SELECT a.*, u.name as candidate_name, u.phone as candidate_phone
     FROM applications a
     LEFT JOIN users u ON a.candidate_id = u.id
     WHERE a.status = 'onboarded'
     AND CAST(a.onboard_time AS INTEGER) < ?
     AND a.notes NOT LIKE '%reminded%'
     ORDER BY a.onboard_time ASC`
  ).all(twoWeeksAgo);
}

// ==================== 校园大使简历管理 ====================
function updateAmbassadorResume(ambassadorId, filename, originalName) {
  const d = getDb();
  d.prepare(
    `UPDATE users SET ambassador_resume_filename = ?, ambassador_resume_original = ?, updated_at = ? WHERE id = ?`
  ).run(filename, originalName, Math.floor(Date.now() / 1000), ambassadorId);
}

function getAmbassadorResume(ambassadorId) {
  const d = getDb();
  return d.prepare(
    `SELECT ambassador_resume_filename as filename, ambassador_resume_original as originalName FROM users WHERE id = ?`
  ).get(ambassadorId);
}

// ==================== HR: 校园大使数据看板 ====================
function getAmbassadorsWithStats() {
  const d = getDb();
  // 获取所有大使
  const ambassadors = d.prepare(
    `SELECT id, phone, name, school, major, ambassador_resume_filename, ambassador_resume_original
     FROM users WHERE role = 'ambassador'
     ORDER BY created_at DESC`
  ).all();

  // 为每个大使计算统计
  const result = ambassadors.map(amb => {
    // 该大使生成的内推码数量
    const codeCount = d.prepare(
      `SELECT COUNT(*) as count FROM referral_codes WHERE ambassador_id = ?`
    ).get(amb.id).count;

    // 该大使的所有内推码ID
    const codes = d.prepare(
      `SELECT id FROM referral_codes WHERE ambassador_id = ?`
    ).all(amb.id).map(c => c.id);

    let referralCount = 0;
    let interviewCount = 0;
    let offerCount = 0;

    if (codes.length > 0) {
      const codeIds = codes.map(c => `'${c}'`).join(',');
      // 推荐简历数（使用这些内推码的申请数）
      referralCount = d.prepare(
        `SELECT COUNT(*) as count FROM applications WHERE referral_code_id IN (${codeIds})`
      ).get().count;

      // 推荐到面数（进入初面及以上）
      interviewCount = d.prepare(
        `SELECT COUNT(*) as count FROM applications
         WHERE referral_code_id IN (${codeIds})
         AND status IN ('first_interview','second_interview','second_rejected','second_waived','offer','offer_rejected','onboarded','resigned')`
      ).get().count;

      // 推荐Offer数（拿到offer及以上）
      offerCount = d.prepare(
        `SELECT COUNT(*) as count FROM applications
         WHERE referral_code_id IN (${codeIds})
         AND status IN ('offer','offer_rejected','onboarded','resigned')`
      ).get().count;
    }

    return {
      id: amb.id,
      phone: amb.phone,
      name: amb.name || '',
      school: amb.school || '',
      major: amb.major || '',
      hasResume: !!amb.ambassador_resume_filename,
      resumeOriginal: amb.ambassador_resume_original || '',
      codeCount,
      referralCount,
      interviewCount,
      offerCount
    };
  });

  // 按推荐简历数排名
  result.sort((a, b) => b.referralCount - a.referralCount);
  result.forEach((amb, idx) => {
    amb.referralRank = amb.referralCount > 0 ? (idx + 1) : '-';
    amb.rank = amb.referralRank; // 综合排名默认等于推荐简历数排名
  });

  return result;
}

// ==================== 公司信息 ====================
function getCompanyInfo(type) {
  const d = getDb();
  const row = d.prepare('SELECT * FROM company_info WHERE type = ?').get(type);
  return row ? row.content : '';
}

function updateCompanyInfo(type, content, updatedBy) {
  const d = getDb();
  d.prepare('UPDATE company_info SET content = ?, updated_by = ?, updated_at = ? WHERE type = ?').run(
    content, updatedBy, Math.floor(Date.now() / 1000), type
  );
  return getCompanyInfo(type);
}

// 候选人的投递进度信息
function getCandidateProgress(candidateId) {
  const d = getDb();
  const app = d.prepare(
    `SELECT a.*, rc.code as referral_code,
     r.ai_score, r.ai_analysis
     FROM applications a
     LEFT JOIN referral_codes rc ON a.referral_code_id = rc.id
     LEFT JOIN resumes r ON a.resume_id = r.id
     WHERE a.candidate_id = ?
     ORDER BY a.created_at DESC LIMIT 1`
  ).get(candidateId);

  if (!app) return null;

  const progress = calculateProgress(app.status);
  const statusText = getStatusText(app.status);

  return {
    application: app,
    progress,
    statusText,
    aiScore: app.ai_score,
    aiAnalysis: app.ai_analysis,
    timeline: buildTimeline(app)
  };
}

function calculateProgress(status) {
  const progressMap = {
    'pending': 5, 'rejected': 0, 'passed': 15,
    'first_interview': 35, 'interview_rejected': 0, 'interview_waived': 0,
    'second_interview': 60, 'second_rejected': 0, 'second_waived': 0,
    'offer': 85, 'offer_rejected': 0,
    'onboarded': 100, 'resigned': 0
  };
  return progressMap[status] || 0;
}

function getStatusText(status) {
  const texts = {
    'pending': '待筛选', 'rejected': '未通过', 'passed': '已通过筛选',
    'first_interview': '初面中', 'interview_rejected': '初面未通过', 'interview_waived': '已放弃面试',
    'second_interview': '复面中', 'second_rejected': '复面未通过', 'second_waived': '已放弃面试',
    'offer': '已发Offer', 'offer_rejected': '已放弃Offer',
    'onboarded': '已入职', 'resigned': '已离职'
  };
  return texts[status] || status;
}

function buildTimeline(app) {
  const steps = [
    { label: '投递简历', done: true, time: app.created_at ? formatTime(app.created_at) : '' },
    { label: '简历筛选', done: app.status !== 'pending', time: '' },
    { label: '初面', done: ['first_interview','second_interview','second_rejected','second_waived','offer','offer_rejected','onboarded','resigned'].includes(app.status), time: app.first_interview_time || '' },
    { label: '复面', done: ['second_interview','second_rejected','second_waived','offer','offer_rejected','onboarded','resigned'].includes(app.status), time: app.second_interview_time || '' },
    { label: 'Offer', done: ['offer','offer_rejected','onboarded','resigned'].includes(app.status), time: '' },
    { label: '入职', done: ['onboarded','resigned'].includes(app.status), time: app.onboard_time || '' }
  ];

  if (['rejected','interview_rejected','second_rejected','interview_waived','second_waived','offer_rejected'].includes(app.status)) {
    const stopLabel = { 'rejected': 1, 'interview_rejected': 2, 'second_rejected': 3, 'interview_waived': 2, 'second_waived': 3, 'offer_rejected': 4 };
    steps[stopLabel[app.status]].label = getStatusText(app.status);
    steps[stopLabel[app.status]].rejected = true;
  }
  return steps;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

module.exports = {
  getDb, hashPassword,
  createVerificationCode, verifyCode,
  findUserByPhone, findUserByEmail, createUser, findUserById, updateUserProfile,
  createReferralCode, getAllReferralCodesByAmbassador, getReferralCodeByCode, getReferralCodeStats,
  createResume, getResumeByCandidate, updateResume, updateApplicationReferralCode,
  updateAmbassadorResume, getAmbassadorResume,
  createApplication, getApplicationByCandidate, getApplicationById,
  updateApplicationStatus, getOperationLogs, getAllApplications,
  getAmbassadorsWithStats,
  getAmbassadorDashboard,
  getHrDashboard, getOnboardingReminders,
  getCompanyInfo, updateCompanyInfo,
  getCandidateProgress,
  // AI评分规则管理
  getAiScoringRules, getActiveAiScoringRule, createAiScoringRule, updateAiScoringRule, deleteAiScoringRule,
  // 数据分析
  getAnalyticsSchoolDistribution, getAnalyticsMajorDistribution, getAnalyticsScoreDistribution,
  getAnalyticsStatusFlow, getAnalyticsTimeline, getAnalyticsLocationDistribution, getAnalyticsDailyTrend
};
