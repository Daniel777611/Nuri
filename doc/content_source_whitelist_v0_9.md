# NURI 内容来源白名单基线 v0.9

- 记录日期：2026-08-03
- 适用分支：`daniel-test`
- 状态：来源基线已确认；具体交付方式以 `recommendation_delivery_contract_v0_1.md` 为准
- 核心原则：白名单精确到机构、栏目、账号或单条内容，不等于整站放行

## 1. 内容等级

- **A — 可自动推荐**：低风险育儿主题完成链接、语言、年龄、日期和商业性校验后可进入推荐池。
- **B — 自动召回后审核**：允许自动检索，但发布前必须通过规则审核或第二模型复核。
- **C — 人工候选**：论文、诊疗内容、个人经验、商业平台和创作者内容，只能逐条审核。

## 2. 英文原文来源

### 2.1 政府、医学会与国际机构

| parent_org_id | 来源 | 允许入口 | 默认等级 |
| --- | --- | --- | --- |
| `cdc` | 美国 CDC | https://www.cdc.gov/act-early/milestones/index.html | A |
| `american_academy_of_pediatrics` | 美国儿科学会 / HealthyChildren | https://www.healthychildren.org/English/ages-stages/Pages/default.aspx | A；论文 C |
| `nih_hhs` | NIH / NICHD / MedlinePlus | https://www.nichd.nih.gov/health/topics | A/B |
| `world_health_organization` | 世界卫生组织 | https://www.who.int/teams/maternal-newborn-child-adolescent-health-and-ageing/child-health/nurturing-care | A/B |
| `nhs_england` | 英国 NHS | https://www.nhs.uk/best-start-in-life/early-learning-development/ | A |

### 2.2 大学、研究与证据来源

| parent_org_id | 来源 | 允许入口 | 默认等级 |
| --- | --- | --- | --- |
| `harvard_center_developing_child` | 哈佛大学发展中儿童中心 | https://developingchild.harvard.edu/resource-guides/ | A/B |
| `stanford_center_early_childhood` | 斯坦福大学早期儿童中心 | https://earlychildhood.stanford.edu/ | B/C |
| `uw_ilabs` | 华盛顿大学 I-LABS | https://modules.ilabs.uw.edu/learning-modules/ | B |
| `cochrane` | Cochrane | https://www.cochrane.org/evidence | B/C |
| `jama_network` | JAMA Pediatrics | https://jamanetwork.com/journals/jamapediatrics | C |
| `srcd` | SRCD / Child Development | https://srcd.onlinelibrary.wiley.com/journal/14678624 | C |

### 2.3 家长友好、精选和案例来源

| parent_org_id | 来源 | 允许入口 | 默认类别 / 等级 |
| --- | --- | --- | --- |
| `raising_children_network` | Raising Children Network | https://raisingchildren.net.au/babies/development | 精选 A |
| `nemours_childrens_health` | Nemours KidsHealth | https://kidshealth.org/en/parents/center/play-learn.html | 精选 A/B |
| `zero_to_three` | ZERO TO THREE | https://www.zerotothree.org/resources/series/parenting-resource/ | 精选/案例 A/B |
| `child_mind_institute` | Child Mind Institute | https://childmind.org/resources/ | 精选 B |
| `sickkids_toronto` | SickKids AboutKidsHealth | https://www.aboutkidshealth.ca/ | 权威 A/B |
| `royal_childrens_hospital_melbourne` | Royal Children's Hospital Melbourne | https://www.rch.org.au/kidsinfo/ | 权威 A/B |
| `british_columbia_healthlinkbc` | HealthLinkBC | https://www.healthlinkbc.ca/living-well/parenting | 权威 A/B |
| `pathways_foundation` | Pathways.org | https://pathways.org/ | 精选 B |
| `seattle_childrens` | Seattle Children's | https://www.seattlechildrens.org/clinics/psychiatry-and-behavioral-medicine/patient-family-resources/ | 权威 B/C |
| `understood_org` | Understood.org | https://www.understood.org/en/topics/personal-stories | 精选/案例 B |
| `sesame_workshop` | Sesame Workshop | https://sesameworkshop.org/resources/ | 精选/案例 B |
| `healthtalk` | Healthtalk / Dipex | https://healthtalk.org/experiences/ | 案例 C |

## 3. 英文机构提供的官方中文资源

这些来源是简体中文用户的最高优先级中文池。官方中文必须由原机构提供；NURI 翻译或浏览器翻译不得标成“官方中文”。

| parent_org_id | 来源 | 中文入口 | 中文形态 | 等级 |
| --- | --- | --- | --- | --- |
| `world_health_organization` | WHO | https://www.who.int/zh/news-room/fact-sheets/detail/infant-and-young-child-feeding | 官方简中 | A |
| `unicef` | UNICEF | https://www.unicef.org/zh/%E5%84%BF%E7%AB%A5%E6%97%A9%E6%9C%9F%E5%8F%91%E5%B1%95 | 官方简中、部分普通话视频 | A/B |
| `us_head_start` | 美国 Head Start | https://headstart.gov/culture-language/article/importance-home-language-series | 官方简中 | A |
| `mayo_clinic` | Mayo Clinic | https://www.mayoclinic.org/zh-hans/healthy-lifestyle/infant-and-toddler-health/basics/toddler-health/hlv-20049400 | 官方简中 | A/B |
| `sickkids_toronto` | SickKids | https://www.aboutkidshealth.ca/zh-Hans/ | 官方简中/繁中 | B |
| `royal_childrens_hospital_melbourne` | RCH Melbourne | https://www.rch.org.au/kidsinfo/translated-fact-sheets/Chinese_simplified_%E2%80%93_%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87/ | 官方简中/繁中 | B |
| `raising_children_network` | Raising Children Network | https://raisingchildren.net.au/for-professionals/other-languages | 简中、普通话 | A/B |
| `british_columbia_healthlinkbc` | HealthLinkBC | https://www.healthlinkbc.ca/health-library/healthlinkbc-files | 主要繁中 PDF | A/B |
| `kidshealth_nz` | KidsHealth New Zealand | https://www.kidshealth.org.nz/formula-feeding/skin-to-skin-contact-formula-feeding | 页面内官方简中 | B |
| `sydney_childrens` | Sydney Children's Hospitals Network | https://www.schn.health.nsw.gov.au/kids-health-hub/parent-and-carer-education | 简中/繁中、中文字幕 | B/C |
| `healthywa_pch` | HealthyWA / Perth Children's Hospital | https://www.healthywa.wa.gov.au/sitecore/content/Hospitals/PCH/Home/For-patients-and-visitors/Child-Health-Facts?AtoZ=B | 简中/繁中 PDF | B |
| `medlineplus` | MedlinePlus | https://medlineplus.gov/languages/infantandnewborncare.html | 简中/繁中双语资料 | B |
| `cochrane` | Cochrane | https://www.cochrane.org/zh-hans/evidence | 官方简中/繁中摘要 | B/C |
| `harvard_center_developing_child` | 哈佛发展中儿童中心 | https://developingchild.harvard.edu/language/zh/ | 官方普通话视频 | B |
| `pathways_foundation` | Pathways.org | https://pathways.org/translations | 中文手册、部分中文视频 | B |
| `global_health_media` | Global Health Media | https://globalhealthmedia.org/ | 多语言视频，逐条确认普通话 | B/C |

CDC 旧中文里程碑 PDF 当前不作为稳定入口；找到与现行英文版本一致的新中文材料后再启用。

## 4. 台湾、香港权威中文来源

### 4.1 台湾

| parent_org_id | 来源 | 允许入口 | 默认类别 / 等级 |
| --- | --- | --- | --- |
| `tw_sfaa_parenting` | 卫福部社会及家庭署育儿亲职网 | https://babyedu.sfaa.gov.tw/ | 权威 A |
| `tw_hpa` | 卫福部国民健康署 | https://www.hpa.gov.tw/Pages/List.aspx?nodeid=3808 | 权威 A |
| `tw_moe_familyedu` | 教育部家庭教育资源网 | https://familyedu.moe.gov.tw/rePublish.aspx?p_id=1120&pid=8905&rt=2002&uid=8911 | 权威/精选 A |
| `ntuh` | 台湾大学附设医院 | https://health.ntuh.gov.tw/health/new/6508.html | 权威 A/B |
| `taipei_veterans` | 台北荣民总医院 | https://wd.vghtpe.gov.tw/PMREIP/Fpage.action?muid=6508 | 权威 B |
| `taiwan_pediatric_association` | 台湾儿科医学会 | https://www.pediatr.org.tw/people/edu.asp | 权威 B/C |
| `fcdd` | 发展迟缓儿童基金会 | https://www.fcdd.org.tw/publication/1 | 精选/案例 B |
| `premature_baby_foundation_tw` | 早产儿基金会 | https://www.pbf.org.tw/foundation/stories | 案例 B |
| `nncf_tw` | 罗慧夫颅颜基金会 | https://www.nncf.org/about/multimedia | 案例 B |
| `eden_tw` | 伊甸基金会 | https://www.eden.org.tw/ | 案例 B/C |

### 4.2 香港

| parent_org_id | 来源 | 允许入口 | 默认类别 / 等级 |
| --- | --- | --- | --- |
| `hk_fhs` | 香港卫生署家庭健康服务 | https://www.fhs.gov.hk/sc_chi/health_info/class_topic/ct_child_health/ct_child_health.html | 权威 A |
| `hk_education_bureau` | 香港教育局 Smart Parent Net | https://www.parent.edu.hk/zh-cn/smart-parent-net/topics/article/framework_pri | 权威/精选 B |
| `hk_hospital_authority` | 香港医院管理局 Smart Patient | https://www.smartpatient.ha.org.hk/zh-cn/smart-patient-web/disease-management/disease-information/by-disease-category/2 | 权威 B/C |
| `hk_childrens_hospital` | 香港儿童医院 | https://www31.ha.org.hk/hkch/Hospital/PatientStories | 案例 B/C |

简体中文用户的视频默认必须是普通话。粤语视频即使带简体字幕，也不能标成普通话视频。

## 5. 中国大陆简体中文来源

### 5.1 政府、疾控与医学会

| parent_org_id | 来源 | 允许入口 | 等级 |
| --- | --- | --- | --- |
| `cn_nhc` | 国家卫生健康委员会 | https://www.nhc.gov.cn/wjw/c100378/202502/658e7e4eb5024746b13186ac0f97a27b.shtml | A |
| `china_cdc` | 中国疾病预防控制中心 | https://www.chinacdc.cn/jkkp/ | A |
| `chinese_medical_association` | 中华医学会 | https://www.cma.org.cn/col/col68/index.html | A/B |
| `cma_pediatrics` | 中华医学会儿科学分会 | https://cps.cma.org.cn/ | A/B；研究内容 C |

### 5.2 公立儿童医院

| parent_org_id | 来源 | 允许入口 | 等级 |
| --- | --- | --- | --- |
| `capital_childrens_medical_center` | 首都儿童医学中心 / 首都儿科研究所 | https://www.shouer.com.cn/health_science.html | B |
| `fudan_childrens` | 复旦大学附属儿科医院 | https://ch.shmu.edu.cn/news/index/id/697.shtml/p/7.html | B |
| `shanghai_childrens` | 上海市儿童医院 | https://www.shchildren.com.cn/channels/640.html | B |
| `guangzhou_women_children` | 广州市妇女儿童医疗中心 | https://www.gzfezx.com/news/lists/15.html | B |
| `zhejiang_childrens` | 浙江大学医学院附属儿童医院 | https://www.zjuch.cn/health/list/126 | B |
| `scmc_guizhou` | 上海儿童医学中心贵州医院 | https://www.scmcgz.cn/jkkp/kpzs.htm | B |
| `beijing_childrens` | 北京儿童医院 | 仅放行确认属于医院的具体科普栏目/账号 | B/C |
| `shenzhen_childrens` | 深圳市儿童医院 | 仅放行确认属于医院的儿童保健与心理健康内容 | B/C |

### 5.3 专业平台

专业平台不得在前台标成政府或大学“权威来源”，应显示“医生审核”或“专业平台精选”。

| parent_org_id | 来源 | 允许内容 | 等级 |
| --- | --- | --- | --- |
| `dxy_doctor` | 丁香医生 | 有医生作者、审核人和日期的健康百科/文章 | B |
| `dxy_mom` | 丁香妈妈 | 有专业作者、审核人、证据和日期的非商业育儿内容 | B |
| `xiaohe` | 小荷医典 | 显示临床审核专家的医学百科 | B |
| `dayi` | 中国医药信息查询平台 | 专家整理、审核、认证的现代儿科内容 | B |
| `tencent_medical` | 腾讯医典 | 无品牌、药品或商业定制的专家审核内容 | B/C |
| `yihe` | 怡禾 | 循证育儿文章与公开问答 | C |
| `distinct_healthcare` | 卓正医疗 | 儿保、睡眠、饮食、发育行为科普 | C |
| `haodf` | 好大夫在线 | 指定三甲医院儿科医生的具体文章 | C |

## 6. 社交平台与高可读性精选池

小红书、YouTube、B站、抖音等平台不做整站放行。允许的是“已核验创作者 + 已核验单条内容”。

### 6.1 专业或高可读性创作者候选

- 裴洪岗及怡禾医生团队
- 儿科医生孔令凯
- 儿科严医生
- 年糕妈妈
- 育婴师安安米琪
- 营养师悟空妈妈
- 小丹丹育儿成长记
- 糖宝很甜
- 溜溜是66
- NONO酱本犟
- 一只莫

### 6.2 真实生活和案例候选

- 潼潼妈咪
- 一只白早早
- 晚安小晚
- 一颗金豆子
- 奶爸小虹哥
- 公立儿童医院和公益机构发布的匿名家庭纪录
- 经过审核的育儿纪录片、YouTube 家庭视频和小红书家庭经验

### 6.3 社交内容准入条件

- 与用户当下问题及孩子发展阶段直接相关。
- 具体、可理解、可执行，不以焦虑或夸张标题驱动。
- 核心事实能绑定至少一条 A/B 级证据锚点。
- 无未披露广告、带货、课程、问诊或医疗导流。
- 医疗、用药、诊断、疫苗和急症内容默认 C 级人工审核。
- 实际检查视频音轨、字幕、时长、可访问性和内容完整性。
- 粉丝量、点赞量和播放量只做弱信号，不单独决定入选。

## 7. 暂不整站放行

- 百度健康
- 春雨医生
- 39健康
- 妈妈网
- 育儿网
- 亲贝网
- 宝宝树
- 中国孕婴童网
- 小红书、抖音、快手、B站和 YouTube 的普通账号

这些平台可以贡献 C 级单条候选，但不能按域名、粉丝量或点赞量自动进入推荐。

## 8. 全局去重与安全规则

- 同一机构的英文、中文、官网、公众号和视频号共用一个 `parent_org_id`。
- 同一组三张首页卡片默认使用三个不同 `parent_org_id`。
- “官方中文”“NURI 中文导读”“中文字幕”“普通话音轨”“粤语音轨”必须分字段存储。
- 中文译文发布前必须确认原文仍存在、版本一致、核心结论一致且没有地区冲突。
- 中国大陆、台湾、香港、美国等地的接种、就医和公共服务信息必须标注地域。
- 个人案例必须明确标注“单个家庭经验，不代表普遍效果或医学建议”。
- 用户最近看过或明确不喜欢的 URL、主题和来源应进入冷却期。

## 9. 已确认的交付契约

白名单只回答“哪些来源可以进入候选池”，不直接决定“用户最终看到什么”。以下事项已在 `recommendation_delivery_contract_v0_1.md` 中定义：

- 首页三张卡片分别承诺什么价值。
- 每张卡片是否包含一篇文章和一个视频，以及两者是否必须来自不同机构。
- 内容如何绑定最近对话、孩子月龄、用户语言和问卷偏好。
- 卡片何时刷新、如何换一组、如何避免点进去仍在搜索。
- 哪些用户行为改变主题排序、类别比例和来源偏好。
- 如何展示推荐理由、证据来源、广告/案例标签和安全边界。
