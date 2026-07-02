require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key';

// ==================== 中间件 ====================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 文件上传配置
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// 限流
const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: '请求过于频繁，请稍后再试' }
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '请求过于频繁，请稍后再试' }
});

// JWT 认证中间件
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: '权限不足' });
    next();
  };
}

// ==================== 认证API（候选人 & 校园大使 — 手机验证码） ====================

// 发送验证码
app.post('/api/auth/send-code', smsLimiter, (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ error: '手机号格式不正确' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.createVerificationCode(phone, code);
  console.log(`\n📱 [验证码] 手机号: ${phone}, 验证码: ${code}\n`);
  res.json({
    message: '验证码已发送',
    code: code
  });
});

// 候选人 & 校园大使 手机验证码登录
app.post('/api/auth/login', (req, res) => {
  const { phone, code, role } = req.body;

  if (!phone || !code || !role) {
    return res.status(400).json({ error: '参数不完整' });
  }

  if (!['candidate', 'ambassador'].includes(role)) {
    return res.status(400).json({ error: '请使用正确的登录入口，HR端请使用邮箱登录' });
  }

  const verified = db.verifyCode(phone, code);
  if (!verified) {
    return res.status(400).json({ error: '验证码错误或已过期' });
  }

  let user = db.findUserByPhone(phone);
  if (!user) {
    user = db.createUser(phone, role);
  } else if (user.role !== role) {
    const d = db.getDb();
    d.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(
      role, Math.floor(Date.now() / 1000), user.id
    );
    user = db.findUserByPhone(phone);
  }

  const token = jwt.sign(
    { id: user.id, phone: user.phone, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: {
      id: user.id, phone: user.phone, role: user.role,
      name: user.name, school: user.school, major: user.major
    }
  });
});

// ==================== HR 邮箱密码登录 ====================

// HR 邮箱密码登录
app.post('/api/auth/hr-login', loginLimiter, (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '请输入邮箱和密码' });
  }

  // 校验邮箱格式：必须是 @hr-mp.com 后缀
  if (!email.endsWith('@hr-mp.com') || email.split('@')[0].length === 0) {
    return res.status(400).json({ error: '邮箱格式不正确，HR端需要使用 @hr-mp.com 邮箱' });
  }

  let user = db.findUserByEmail(email);
  if (!user) {
    // 自动注册：@hr-mp.com 邮箱首次登录，默认密码 123456
    const d = db.getDb();
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const hashedPassword = db.hashPassword(password);
    d.prepare(
      "INSERT INTO users (id, phone, email, role, password_hash, name, created_at, updated_at) VALUES (?, ?, ?, 'hr', ?, ?, ?, ?)"
    ).run(id, null, email, hashedPassword, email.split('@')[0], now, now);
    user = db.findUserByEmail(email);
  }

  if (user.role !== 'hr') {
    return res.status(403).json({ error: '该账号非HR角色' });
  }

  const hashedPassword = db.hashPassword(password);
  if (user.password_hash !== hashedPassword) {
    return res.status(400).json({ error: '密码错误' });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: {
      id: user.id, email: user.email, role: user.role,
      name: user.name
    }
  });
});

// HR 修改密码
app.put('/api/auth/hr-password', authenticate, requireRole('hr'), (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '请输入旧密码和新密码' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码长度不能少于6位' });
  }

  const d = db.getDb();
  const user = db.findUserById(req.user.id);
  const hashedOld = db.hashPassword(oldPassword);

  if (user.password_hash !== hashedOld) {
    return res.status(400).json({ error: '旧密码错误' });
  }

  d.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    db.hashPassword(newPassword), Math.floor(Date.now() / 1000), req.user.id
  );

  res.json({ message: '密码修改成功' });
});

// 获取当前用户信息
app.get('/api/auth/me', authenticate, (req, res) => {
  const user = db.findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({
    id: user.id, phone: user.phone, email: user.email,
    role: user.role, name: user.name,
    school: user.school, major: user.major,
    ambassadorResumeFilename: user.ambassador_resume_filename || null,
    ambassadorResumeOriginal: user.ambassador_resume_original || null
  });
});

// 更新用户信息
app.put('/api/auth/profile', authenticate, (req, res) => {
  const { name, school, major } = req.body;
  const d = db.getDb();
  d.prepare('UPDATE users SET name = ?, school = ?, major = ?, updated_at = ? WHERE id = ?').run(
    name || null, school || null, major || null,
    Math.floor(Date.now() / 1000), req.user.id
  );
  const user = db.findUserById(req.user.id);
  res.json({
    id: user.id, phone: user.phone, email: user.email,
    role: user.role, name: user.name, school: user.school, major: user.major
  });
});

// ==================== 候选人API ====================

// 上传/更新简历（内推码可选，支持重新投递）
app.post('/api/candidate/resume', authenticate, requireRole('candidate'), upload.single('resume'), (req, res) => {
  const referralCode = (req.body.referralCode || '').trim();
  
  // 内推码可选：如果填写了则验证，不填则跳过
  let referralCodeId = null;
  if (referralCode) {
    const rc = db.getReferralCodeByCode(referralCode.toUpperCase());
    if (!rc) return res.status(400).json({ error: '内推码无效' });
    referralCodeId = rc.id;
  }

  const existingApp = db.getApplicationByCandidate(req.user.id);
  
  if (existingApp) {
    // 已有申请 → 更新简历
    if (!req.file) return res.status(400).json({ error: '请上传简历文件' });
    
    const resume = db.updateResume(
      req.user.id, referralCodeId,
      req.file.filename, req.file.originalname,
      `/uploads/${req.file.filename}`
    );
    
    // 如果提供了内推码，更新申请记录的推荐码
    if (referralCodeId) {
      db.updateApplicationReferralCode(req.user.id, referralCodeId);
    }
    
    res.json({
      message: '简历更新成功',
      application: db.getApplicationById(existingApp.id)
    });
  } else {
    // 新投递
    if (!req.file) return res.status(400).json({ error: '请上传简历文件' });

    const resume = db.createResume(
      req.user.id, referralCodeId,
      req.file.filename, req.file.originalname,
      `/uploads/${req.file.filename}`
    );

    const application = db.createApplication(req.user.id, referralCodeId, resume.id);

    res.json({
      message: '简历投递成功',
      application: db.getApplicationById(application.id)
    });
  }
});

// 获取投递进度
app.get('/api/candidate/progress', authenticate, requireRole('candidate'), (req, res) => {
  const progress = db.getCandidateProgress(req.user.id);
  res.json(progress);
});

// ==================== 校园大使API ====================

// 大使上传自己的简历（生成内推码的前置条件）
app.post('/api/ambassador/resume', authenticate, requireRole('ambassador'), upload.single('resume'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传简历文件' });
  const allowedTypes = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png'];
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!allowedTypes.includes(ext)) {
    return res.status(400).json({ error: '仅支持 PDF、Word、JPG、PNG 格式' });
  }
  db.updateAmbassadorResume(req.user.id, req.file.filename, req.file.originalname);
  res.json({ message: '简历上传成功', filename: req.file.filename, originalName: req.file.originalname });
});

// 生成内推码（含使用场景）
app.post('/api/ambassador/referral-code', authenticate, requireRole('ambassador'), (req, res) => {
  // 检查是否已上传大使本人简历
  const ambassadorResume = db.getAmbassadorResume(req.user.id);
  if (!ambassadorResume || !ambassadorResume.filename) {
    return res.status(400).json({ error: '请先上传您的个人简历，才能生成内推码' });
  }

  const { scene } = req.body || {};
  if (!scene || !scene.trim()) {
    return res.status(400).json({ error: '请填写内推码使用场景' });
  }
  const code = db.createReferralCode(req.user.id, scene.trim());
  res.json(code);
});

// 获取所有内推码及各自统计
app.get('/api/ambassador/referral-codes', authenticate, requireRole('ambassador'), (req, res) => {
  const codes = db.getAllReferralCodesByAmbassador(req.user.id);
  const codesWithStats = codes.map(c => ({
    ...c,
    stats: db.getReferralCodeStats(c.id)
  }));
  res.json(codesWithStats);
});

// 获取综合数据看板
app.get('/api/ambassador/dashboard', authenticate, requireRole('ambassador'), (req, res) => {
  const dashboard = db.getAmbassadorDashboard(req.user.id);
  const codes = db.getAllReferralCodesByAmbassador(req.user.id);
  res.json({ ...dashboard, codes: codes.map(c => ({ ...c, stats: db.getReferralCodeStats(c.id) })) });
});

// ==================== HR API ====================

// HR数据看板
app.get('/api/hr/dashboard', authenticate, requireRole('hr'), (req, res) => {
  const dashboard = db.getHrDashboard();
  const reminders = db.getOnboardingReminders();
  res.json({ ...dashboard, reminders });
});

// 人才库列表（支持地点、高校、专业、状态筛选）
app.get('/api/hr/applications', authenticate, requireRole('hr'), (req, res) => {
  const { school, major, location, status, search } = req.query;
  const filters = {};
  if (school) filters.school = school;
  if (major) filters.major = major;
  if (location) filters.location = location;
  if (status) filters.status = status;
  if (search) filters.search = search;
  const applications = db.getAllApplications(filters);
  res.json(applications);
});

// 人才库详情
app.get('/api/hr/applications/:id', authenticate, requireRole('hr'), (req, res) => {
  const app = db.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: '申请不存在' });
  const logs = db.getOperationLogs(req.params.id);
  res.json({ application: app, operationLogs: logs });
});

// 操作候选人状态
app.put('/api/hr/applications/:id/status', authenticate, requireRole('hr'), (req, res) => {
  const { status, first_interview_time, second_interview_time, onboard_time, resign_time, notes, tags, location } = req.body;
  const app = db.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: '申请不存在' });

  const previousStatus = app.status;

  const validTransitions = {
    'pending': ['passed', 'rejected'],
    'passed': ['first_interview', 'rejected'],
    'first_interview': ['second_interview', 'interview_rejected', 'interview_waived', 'offer'],
    'second_interview': ['second_rejected', 'second_waived', 'offer'],
    'offer': ['onboarded', 'offer_rejected'],
    'onboarded': ['resigned']
  };

  if (!validTransitions[previousStatus] || !validTransitions[previousStatus].includes(status)) {
    return res.status(400).json({
      error: `不允许从 ${previousStatus} 转为 ${status}`,
      allowed: validTransitions[previousStatus] || []
    });
  }

  const extra = { previousStatus };
  if (first_interview_time) extra.first_interview_time = first_interview_time;
  if (second_interview_time) extra.second_interview_time = second_interview_time;
  if (onboard_time) extra.onboard_time = onboard_time;
  if (resign_time) extra.resign_time = resign_time;
  if (tags !== undefined) extra.tags = tags;
  if (location !== undefined) extra.location = location;
  if (notes) extra.notes = notes;

  const updated = db.updateApplicationStatus(req.params.id, status, req.user.id, extra);
  const logs = db.getOperationLogs(req.params.id);

  res.json({ application: updated, operationLogs: logs });
});

// 下载简历
app.get('/api/hr/resumes/:filename', authenticate, requireRole('hr'), (req, res) => {
  const filePath = path.join(__dirname, 'uploads', req.params.filename);
  res.download(filePath);
});

// 标记入职提醒已处理
app.put('/api/hr/applications/:id/remind', authenticate, requireRole('hr'), (req, res) => {
  const d = db.getDb();
  d.prepare("UPDATE applications SET notes = COALESCE(notes,'') || ' reminded' WHERE id = ?").run(req.params.id);
  res.json({ message: '已标记' });
});

// ==================== AI评分规则API ====================

// 获取所有评分规则
app.get('/api/hr/scoring-rules', authenticate, requireRole('hr'), (req, res) => {
  const rules = db.getAiScoringRules();
  res.json(rules);
});

// 创建新评分规则
app.post('/api/hr/scoring-rules', authenticate, requireRole('hr'), (req, res) => {
  const { rule_name, dimensions, weights, thresholds } = req.body;
  
  if (!rule_name || !dimensions || !weights) {
    return res.status(400).json({ error: '参数不完整' });
  }
  
  try {
    const rule = db.createAiScoringRule(rule_name, dimensions, weights, thresholds || {}, req.user.id);
    res.json(rule);
  } catch (e) {
    res.status(500).json({ error: '创建失败: ' + e.message });
  }
});

// 更新评分规则
app.put('/api/hr/scoring-rules/:id', authenticate, requireRole('hr'), (req, res) => {
  const { rule_name, dimensions, weights, thresholds, is_active } = req.body;
  
  try {
    const rule = db.updateAiScoringRule(req.params.id, {
      rule_name, dimensions, weights, thresholds, is_active
    });
    res.json(rule);
  } catch (e) {
    res.status(500).json({ error: '更新失败: ' + e.message });
  }
});

// 删除评分规则
app.delete('/api/hr/scoring-rules/:id', authenticate, requireRole('hr'), (req, res) => {
  try {
    db.deleteAiScoringRule(req.params.id);
    res.json({ message: '删除成功' });
  } catch (e) {
    res.status(500).json({ error: '删除失败: ' + e.message });
  }
});

// 激活评分规则
app.put('/api/hr/scoring-rules/:id/activate', authenticate, requireRole('hr'), (req, res) => {
  const d = db.getDb();
  // 先取消所有规则的激活状态
  d.prepare('UPDATE ai_scoring_rules SET is_active = 0').run();
  // 激活指定规则
  d.prepare('UPDATE ai_scoring_rules SET is_active = 1, updated_at = ? WHERE id = ?').run(
    Math.floor(Date.now() / 1000), req.params.id
  );
  res.json({ message: '激活成功' });
});

// ==================== 数据分析API ====================

// 高校分布
app.get('/api/hr/analytics/school-distribution', authenticate, requireRole('hr'), (req, res) => {
  const data = db.getAnalyticsSchoolDistribution();
  res.json(data);
});

// 专业分布
app.get('/api/hr/analytics/major-distribution', authenticate, requireRole('hr'), (req, res) => {
  const data = db.getAnalyticsMajorDistribution();
  res.json(data);
});

// AI评分分布
app.get('/api/hr/analytics/score-distribution', authenticate, requireRole('hr'), (req, res) => {
  const data = db.getAnalyticsScoreDistribution();
  res.json(data);
});

// 状态流转统计
app.get('/api/hr/analytics/status-flow', authenticate, requireRole('hr'), (req, res) => {
  const data = db.getAnalyticsStatusFlow();
  res.json(data);
});

// 时间线数据
app.get('/api/hr/analytics/timeline', authenticate, requireRole('hr'), (req, res) => {
  const data = db.getAnalyticsTimeline();
  res.json(data);
});

// 地点分布
app.get('/api/hr/analytics/location-distribution', authenticate, requireRole('hr'), (req, res) => {
  const data = db.getAnalyticsLocationDistribution();
  res.json(data);
});

// 每日趋势
app.get('/api/hr/analytics/daily-trend', authenticate, requireRole('hr'), (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const data = db.getAnalyticsDailyTrend(days);
  res.json(data);
});

// 综合数据分析看板
app.get('/api/hr/analytics/dashboard', authenticate, requireRole('hr'), (req, res) => {
  const dashboard = {
    schoolDistribution: db.getAnalyticsSchoolDistribution(),
    majorDistribution: db.getAnalyticsMajorDistribution(),
    scoreDistribution: db.getAnalyticsScoreDistribution(),
    statusFlow: db.getAnalyticsStatusFlow(),
    locationDistribution: db.getAnalyticsLocationDistribution(),
    dailyTrend: db.getAnalyticsDailyTrend(30)
  };
  res.json(dashboard);
});

// ==================== HR: 校园大使数据看板 ====================

// 获取所有校园大使及其业绩数据
app.get('/api/hr/ambassadors', authenticate, requireRole('hr'), (req, res) => {
  const data = db.getAmbassadorsWithStats();
  res.json(data);
});

// 获取某大使的推荐简历列表
app.get('/api/hr/ambassadors/:id/applications', authenticate, requireRole('hr'), (req, res) => {
  const d = db.getDb();
  const ambassadorId = req.params.id;
  // 获取该大使的所有内推码
  const codes = d.prepare('SELECT id FROM referral_codes WHERE ambassador_id = ?').all(ambassadorId).map(c => c.id);
  if (codes.length === 0) return res.json([]);
  const codeIds = codes.map(c => `'${c}'`).join(',');
  const apps = d.prepare(
    `SELECT a.*, u.phone as candidate_phone, u.name as candidate_name, u.school, u.major,
      r.original_name as resume_name, r.file_path as resume_path, r.ai_score,
      rc.code as referral_code
     FROM applications a
     LEFT JOIN users u ON a.candidate_id = u.id
     LEFT JOIN resumes r ON a.resume_id = r.id
     LEFT JOIN referral_codes rc ON a.referral_code_id = rc.id
     WHERE a.referral_code_id IN (${codeIds})
     ORDER BY a.created_at DESC`
  ).all();
  res.json(apps);
});

// ==================== 公司信息API ====================

app.get('/api/company/info/:type', (req, res) => {
  const { type } = req.params;
  if (!['intro', 'recruitment'].includes(type)) {
    return res.status(400).json({ error: '无效的信息类型' });
  }
  res.json({ content: db.getCompanyInfo(type) });
});

app.put('/api/company/info/:type', authenticate, requireRole('hr'), (req, res) => {
  const { type } = req.params;
  const { content } = req.body;
  if (!['intro', 'recruitment'].includes(type)) {
    return res.status(400).json({ error: '无效的信息类型' });
  }
  const updated = db.updateCompanyInfo(type, content, req.user.id);
  res.json({ content: updated });
});

// ==================== 健康检查 ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ==================== 错误处理 ====================
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: '文件大小不能超过20MB' });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: '文件上传错误' });
  }
  res.status(500).json({ error: '服务器内部错误' });
});

// ==================== 启动 ====================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   🏢 对点咨询 校招管理系统 v2.0             ║
║                                              ║
║   候选人端:  http://localhost:${PORT}          ║
║   大使端:    http://localhost:${PORT}          ║
║   HR端:      http://localhost:${PORT}/hr.html ║
║                                              ║
║   HR端:   任意 @hr-mp.com 邮箱 / 初始密码 123456 ║
╚══════════════════════════════════════════════╝
  `);
});
