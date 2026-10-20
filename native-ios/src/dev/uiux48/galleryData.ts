// Development-only design fixtures. NOT users, service responses or backend contracts.
// Resolved out of every production bundle by metro.config.js.
export type Copy48 = readonly [string,string];
export type GalleryBlock = {kind:string;copy:Copy48[];target?:string;note?:boolean;heading?:boolean};
export type GalleryScreen = {key:string;title:Copy48;node:string;blocks:GalleryBlock[]};
export const FIXTURE_SENTINEL = "NURI_UIUX48_ISOLATED_GALLERY_20261019";
export const GALLERY_SCREENS:GalleryScreen[] = [
  {
    "key": "community",
    "title": [
      "社区",
      "Community"
    ],
    "node": "1066:35345",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "今天，你需要什么？",
            "What do you need today?"
          ]
        ],
        "heading": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "向有相似经历的家长提问",
            "Ask parents with similar experiences"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "发一个漂流瓶，听听其他家长的经验。",
            "Send a bottle and hear other parents' experiences."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "认识聊得来的家长",
            "Meet parents you connect with"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "认识附近、兴趣相投的家长。",
            "Meet nearby parents with shared interests."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "聊天与漂流瓶",
            "Chats & bottles"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "2 位家长回复了你的漂流瓶",
            "Two parents replied to your bottle"
          ]
        ]
      }
    ]
  },
  {
    "key": "bottleCompose",
    "title": [
      "发一个漂流瓶",
      "Send a bottle"
    ],
    "node": "1066:35666",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "最近有什么想问其他家长？",
            "What would you like to ask other parents?"
          ]
        ],
        "heading": true
      },
      {
        "kind": "field",
        "copy": [
          [
            "你的问题",
            "Your question"
          ],
          [
            "我的宝宝每天去托育时都会哭。有家长经历过吗？",
            "My baby cries at daycare every day. Has anyone experienced this?"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "Nuri 会帮你整理表达，只分享需要的信息。话题：托育适应。",
            "Nuri helps organize your words and share only what is needed. Topic: daycare adjustment."
          ]
        ],
        "note": true
      },
      {
        "kind": "choices",
        "copy": [
          [
            "谁能看到你的称呼？",
            "Who can see your name?"
          ],
          [
            "匿名",
            "Anonymous"
          ],
          [
            "仅名字",
            "First name only"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "只分享大致区域与孩子年龄段，不分享学校、地址和生日。",
            "Share only a broad area and age range, not schools, addresses or birthdays."
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "继续",
            "Continue"
          ]
        ],
        "target": "bottleRefine"
      }
    ]
  },
  {
    "key": "bottleRefine",
    "title": [
      "整理你的问题",
      "Refine your question"
    ],
    "node": "1066:36014",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "你的原始问题",
            "Your original question"
          ]
        ],
        "heading": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "我的宝宝每天去托育时都会哭。有家长经历过吗？",
            "My baby cries at daycare every day. Has anyone experienced this?"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "Nuri 建议的版本",
            "Nuri's suggested version"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "宝宝每天在托育告别时都会哭。什么方法曾帮助你们平稳度过这个阶段？",
            "My baby cries at daycare goodbye every day. What helped your family through this stage?"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "已去除托育机构名称，让问题更容易回答。仅分享幼儿年龄段。",
            "The daycare name was removed to make the question easier to answer. Only an age range is shared."
          ]
        ],
        "note": true
      },
      {
        "kind": "row",
        "copy": [
          [
            "使用这个版本",
            "Use this version"
          ]
        ],
        "target": "bottleWaiting"
      },
      {
        "kind": "row",
        "copy": [
          [
            "继续编辑",
            "Keep editing"
          ]
        ],
        "target": "bottleCompose"
      },
      {
        "kind": "row",
        "copy": [
          [
            "保留原文",
            "Keep original"
          ]
        ],
        "target": "bottleWaiting"
      },
      {
        "kind": "action",
        "copy": [
          [
            "继续",
            "Continue"
          ]
        ],
        "target": "bottleWaiting"
      }
    ]
  },
  {
    "key": "bottleWaiting",
    "title": [
      "你的漂流瓶",
      "Your bottle"
    ],
    "node": "1066:36383",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "漂流瓶已经出发了。",
            "Your bottle is on its way."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "我们会送给可能有相关经历的家长。",
            "We will share it with parents who may have relevant experience."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "话题：托育适应",
            "Topic: daycare adjustment"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "对象：有托育适应经历的幼儿家长",
            "Audience: parents of toddlers with daycare experience"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "显示为：匿名",
            "Shown as: Anonymous"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "家长有空时会回复，有新回复会通知你。",
            "Parents reply when they can. New replies will be notified."
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "返回社区",
            "Back to Community"
          ]
        ],
        "target": "community"
      },
      {
        "kind": "action",
        "copy": [
          [
            "查看我的漂流瓶",
            "View my bottle"
          ]
        ],
        "target": "bottleEmpty"
      }
    ]
  },
  {
    "key": "bottleEmpty",
    "title": [
      "暂时还没有回复",
      "No replies yet"
    ],
    "node": "1066:36695",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "漂流瓶还在路上。其他家长会在方便时回复。",
            "Your bottle is still on its way. Other parents will reply when they can."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "返回社区",
            "Back to Community"
          ]
        ],
        "target": "community"
      },
      {
        "kind": "action",
        "copy": [
          [
            "编辑问题",
            "Edit question"
          ]
        ],
        "target": "bottleCompose"
      }
    ]
  },
  {
    "key": "bottleReplies",
    "title": [
      "托育适应 · 2 条回复",
      "Daycare adjustment · 2 replies"
    ],
    "node": "1066:36986",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "两位家长分享了自己的经验。",
            "Two parents shared their experiences."
          ]
        ],
        "heading": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "Maya · 幼儿家长",
            "Maya · Toddler parent"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "我们也哭了好几周。固定、简短的告别仪式很有帮助，我们也不会偷偷离开。",
            "We cried for weeks too. A consistent, brief goodbye ritual helped, and we never slipped away."
          ]
        ]
      },
      {
        "kind": "choices",
        "copy": [
          [
            "回应 Maya",
            "Respond to Maya"
          ],
          [
            "有帮助",
            "Helpful"
          ],
          [
            "我会试试",
            "I'll try it"
          ],
          [
            "谢谢",
            "Thank you"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "匿名 · 学龄前儿童家长",
            "Anonymous · Preschool parent"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "大约第三周开始好转。带一件熟悉的安抚物，让告别容易了一些。",
            "Things improved around week three. A familiar comfort object made goodbyes a little easier."
          ]
        ]
      },
      {
        "kind": "choices",
        "copy": [
          [
            "你的感受",
            "How you feel"
          ],
          [
            "没那么孤单了",
            "Less alone"
          ]
        ]
      },
      {
        "kind": "row",
        "copy": [
          [
            "再追问一个问题",
            "Ask a follow-up"
          ]
        ],
        "target": "bottleCompose"
      },
      {
        "kind": "row",
        "copy": [
          [
            "关闭这个漂流瓶",
            "Close this bottle"
          ]
        ],
        "target": "bottleClose"
      }
    ]
  },
  {
    "key": "bottleClose",
    "title": [
      "结束这次问答？",
      "End this Q&A?"
    ],
    "node": "1066:37387",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "似乎你已经找到了需要的回应。",
            "It seems you found the response you needed."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "Nuri 小结：简短的告别仪式、不偷偷离开，以及熟悉的安抚物，是家长们分享的方法。",
            "Nuri summary: parents suggested short goodbyes, not slipping away, and a familiar comfort object."
          ]
        ],
        "note": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "关闭会结束问答，不会自动与回复的家长建立联系。",
            "Closing ends the Q&A. It will not connect you to the parents who replied."
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "关闭漂流瓶",
            "Close bottle"
          ]
        ],
        "target": "community"
      },
      {
        "kind": "action",
        "copy": [
          [
            "继续保留",
            "Keep open"
          ]
        ],
        "target": "bottleReplies"
      }
    ]
  },
  {
    "key": "bottleRespond",
    "title": [
      "一位家长需要你的经验",
      "A parent needs your experience"
    ],
    "node": "1066:39294",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "“宝宝每天在托育告别时都会哭。什么方法曾帮助你们？”",
            "“My baby cries at daycare goodbye every day. What helped your family?”"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "你收到它，是因为你分享过托育适应方面的经历。",
            "You received this because you shared experience with daycare adjustment."
          ]
        ],
        "note": true
      },
      {
        "kind": "choices",
        "copy": [
          [
            "这段经历适合你吗？",
            "Is this experience familiar?"
          ],
          [
            "我能帮忙",
            "I can help"
          ],
          [
            "不太了解",
            "Not familiar"
          ]
        ]
      },
      {
        "kind": "field",
        "copy": [
          [
            "分享你的经验",
            "Share your experience"
          ],
          [
            "说说对你们有用的方法…",
            "Tell us what worked for your family…"
          ]
        ]
      },
      {
        "kind": "row",
        "copy": [
          [
            "语音回答",
            "Voice answer"
          ]
        ],
        "target": "communityVoice"
      },
      {
        "kind": "row",
        "copy": [
          [
            "帮我整理回答",
            "Help refine my answer"
          ]
        ],
        "target": "bottleRefine"
      },
      {
        "kind": "action",
        "copy": [
          [
            "发送回应",
            "Send response"
          ]
        ],
        "target": "communityInbox"
      },
      {
        "kind": "action",
        "copy": [
          [
            "稍后再说",
            "Maybe later"
          ]
        ],
        "target": "community"
      }
    ]
  },
  {
    "key": "matchIntent",
    "title": [
      "想认识怎样的家长？",
      "Who would you like to meet?"
    ],
    "node": "1066:39680",
    "blocks": [
      {
        "kind": "choices",
        "copy": [
          [
            "你希望找到",
            "You hope to find"
          ],
          [
            "聊育儿的家长",
            "Parents to talk about parenting"
          ],
          [
            "附近的家长朋友",
            "Nearby parent friends"
          ],
          [
            "一起遛娃的家长",
            "Parents for walks with children"
          ],
          [
            "相似经历",
            "Similar experiences"
          ],
          [
            "相同兴趣",
            "Shared interests"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "可以多选，也可以随时修改。只有双方愿意时才会建立联系。",
            "Choose more than one and change them anytime. You connect only if both parents agree."
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "下一步",
            "Next"
          ]
        ],
        "target": "matchProfile"
      },
      {
        "kind": "action",
        "copy": [
          [
            "暂时不用",
            "Not now"
          ]
        ],
        "target": "community"
      }
    ]
  },
  {
    "key": "matchProfile",
    "title": [
      "简单介绍一下自己",
      "Introduce yourself"
    ],
    "node": "1066:40046",
    "blocks": [
      {
        "kind": "choices",
        "copy": [
          [
            "兴趣",
            "Interests"
          ],
          [
            "咖啡",
            "Coffee"
          ],
          [
            "徒步",
            "Hiking"
          ],
          [
            "阅读",
            "Reading"
          ],
          [
            "艺术",
            "Art"
          ],
          [
            "美食",
            "Food"
          ],
          [
            "健身",
            "Fitness"
          ]
        ]
      },
      {
        "kind": "choices",
        "copy": [
          [
            "社交方式",
            "Social style"
          ],
          [
            "文字交流",
            "Text conversations"
          ],
          [
            "安静相处",
            "Quiet company"
          ],
          [
            "一起遛娃",
            "Walks with children"
          ]
        ]
      },
      {
        "kind": "choices",
        "copy": [
          [
            "希望认识",
            "Who to meet"
          ],
          [
            "所有家长",
            "All parents"
          ],
          [
            "妈妈",
            "Moms"
          ],
          [
            "爸爸",
            "Dads"
          ],
          [
            "相同性别",
            "Same gender"
          ]
        ]
      },
      {
        "kind": "field",
        "copy": [
          [
            "位置",
            "Location"
          ],
          [
            "只显示大致区域和距离",
            "Only a broad area and distance are shown"
          ]
        ]
      },
      {
        "kind": "field",
        "copy": [
          [
            "关于自己的一件事",
            "One thing about yourself"
          ],
          [
            "喜欢咖啡，也想在孩子托育时找人聊聊。",
            "I enjoy coffee and would like someone to chat with while my child is at daycare."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "寻找家长",
            "Find parents"
          ]
        ],
        "target": "matchDiscovery"
      }
    ]
  },
  {
    "key": "matchDiscovery",
    "title": [
      "可能聊得来的家长",
      "Parents you may connect with"
    ],
    "node": "1066:40550",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "根据你分享的偏好：附近的家长朋友、幼儿阶段、安静的周末。",
            "Based on your preferences: nearby parent friends, toddlers and quiet weekends."
          ]
        ],
        "note": true
      },
      {
        "kind": "row",
        "copy": [
          [
            "Maya",
            "Maya"
          ],
          [
            "约 1 英里 · 孩子年龄相近 · 咖啡、徒步",
            "About 1 mile · Similar child ages · Coffee, hiking"
          ]
        ],
        "target": "matchDetail"
      },
      {
        "kind": "row",
        "copy": [
          [
            "Deana",
            "Deana"
          ],
          [
            "约 2 英里 · 都从事创意工作 · 设计、阅读",
            "About 2 miles · Creative work · Design, reading"
          ]
        ],
        "target": "matchDetail"
      },
      {
        "kind": "row",
        "copy": [
          [
            "Sonya",
            "Sonya"
          ],
          [
            "约 2.5 英里 · 都喜欢徒步 · 健身、烹饪",
            "About 2.5 miles · Hiking · Fitness, cooking"
          ]
        ],
        "target": "matchDetail"
      }
    ]
  },
  {
    "key": "matchEmpty",
    "title": [
      "还没有匹配到家长",
      "No matches yet"
    ],
    "node": "1066:40896",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "我们还在寻找附近合适的家长。有结果时会通知你。",
            "We are still looking for suitable nearby parents. You will be notified when there is a result."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "扩大距离范围",
            "Expand distance"
          ]
        ],
        "target": "matchProfile"
      },
      {
        "kind": "action",
        "copy": [
          [
            "调整偏好",
            "Adjust preferences"
          ]
        ],
        "target": "matchIntent"
      }
    ]
  },
  {
    "key": "matchDetail",
    "title": [
      "认识 Maya",
      "Meet Maya"
    ],
    "node": "1066:41187",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "Maya · 约 1 英里",
            "Maya · About 1 mile"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "希望认识：附近的家长朋友",
            "Hoping to meet: nearby parent friends"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "你们可能聊得来的原因",
            "Why you may connect"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "孩子年龄相近",
            "Similar child ages"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "都在经历学龄前阶段",
            "Both navigating the preschool stage"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "都喜欢安静的周末活动",
            "Both enjoy quiet weekend activities"
          ]
        ]
      },
      {
        "kind": "choices",
        "copy": [
          [
            "Maya 的兴趣",
            "Maya's interests"
          ],
          [
            "咖啡",
            "Coffee"
          ],
          [
            "博物馆",
            "Museums"
          ],
          [
            "徒步",
            "Hiking"
          ],
          [
            "阅读",
            "Reading"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "关于 Maya",
            "About Maya"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "喜欢画画，也知道托育附近一家不错的小餐馆。",
            "Enjoys drawing and knows a nice little restaurant near daycare."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "建立联系",
            "Connect"
          ]
        ],
        "target": "matchConnected"
      },
      {
        "kind": "action",
        "copy": [
          [
            "稍后再说",
            "Maybe later"
          ]
        ],
        "target": "matchDiscovery"
      }
    ]
  },
  {
    "key": "matchConnected",
    "title": [
      "你们已建立联系",
      "You are connected"
    ],
    "node": "1066:41561",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "看来你们有不少可以聊的话题。",
            "It looks like you have plenty to talk about."
          ]
        ],
        "heading": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "你们都有幼儿，住得不远，也喜欢安静的周末活动。",
            "You both have toddlers, live nearby and enjoy quiet weekend activities."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "可以这样开始：你们都住在同一座公园附近，带孩子去过吗？",
            "Try starting here: you both live near the same park. Have you taken your children there?"
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "开始聊天",
            "Start chatting"
          ]
        ],
        "target": "communityNewChat"
      },
      {
        "kind": "action",
        "copy": [
          [
            "暂时不用",
            "Not now"
          ]
        ],
        "target": "community"
      }
    ]
  },
  {
    "key": "communityInbox",
    "title": [
      "聊天与漂流瓶",
      "Chats & bottles"
    ],
    "node": "1066:41866",
    "blocks": [
      {
        "kind": "row",
        "copy": [
          [
            "2 位家长回复了你的漂流瓶",
            "Two parents replied to your bottle"
          ],
          [
            "托育适应",
            "Daycare adjustment"
          ]
        ],
        "target": "bottleReplies"
      },
      {
        "kind": "row",
        "copy": [
          [
            "Maya",
            "Maya"
          ],
          [
            "你：也许会在那里碰到你。 · 2 分钟前",
            "You: Maybe we'll see you there. · 2 minutes ago"
          ]
        ],
        "target": "communityChat"
      },
      {
        "kind": "row",
        "copy": [
          [
            "Dani",
            "Dani"
          ],
          [
            "谢谢你建立联系！ · 周二",
            "Thanks for connecting! · Tuesday"
          ]
        ],
        "target": "communityNewChat"
      },
      {
        "kind": "row",
        "copy": [
          [
            "Priya",
            "Priya"
          ],
          [
            "新联系 · 用一个轻松的问题开始",
            "New connection · Start with an easy question"
          ]
        ],
        "target": "communityNewChat"
      },
      {
        "kind": "row",
        "copy": [
          [
            "有家长想听听你的经验",
            "A parent would like your experience"
          ]
        ],
        "target": "bottleRespond"
      },
      {
        "kind": "text",
        "copy": [
          [
            "稍后联系",
            "Contact later"
          ]
        ]
      },
      {
        "kind": "row",
        "copy": [
          [
            "Sam",
            "Sam"
          ],
          [
            "孩子年龄相近 · 约 1 英里",
            "Similar child ages · About 1 mile"
          ]
        ],
        "target": "matchDetail"
      },
      {
        "kind": "row",
        "copy": [
          [
            "Jo",
            "Jo"
          ],
          [
            "都喜欢徒步 · 约 3 英里",
            "Both enjoy hiking · About 3 miles"
          ]
        ],
        "target": "matchDetail"
      },
      {
        "kind": "text",
        "copy": [
          [
            "只有你能看到此列表。暂存的家长将在 30 天后清除。",
            "Only you can see this list. Saved parents are removed after 30 days."
          ]
        ],
        "note": true
      },
      {
        "kind": "row",
        "copy": [
          [
            "聊天设置",
            "Chat settings"
          ]
        ],
        "target": "communityPreferences"
      }
    ]
  },
  {
    "key": "communityNewChat",
    "title": [
      "Maya",
      "Maya"
    ],
    "node": "1066:42326",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "你们都有幼儿，也都喜欢附近的周末活动。",
            "You both have toddlers and enjoy nearby weekend activities."
          ]
        ],
        "note": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "轻松打个招呼",
            "Say an easy hello"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "去过附近的公园吗？",
            "Have you visited the nearby park?"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "想聊聊最近的睡前作息吗？",
            "Want to chat about recent bedtime routines?"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "最近看了什么好电影？",
            "Seen any good movies lately?"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "可以使用一句，修改后发送，或自己写。",
            "Use a suggestion, edit before sending, or write your own."
          ]
        ],
        "note": true
      }
    ]
  },
  {
    "key": "communityChat",
    "title": [
      "Maya",
      "Maya"
    ],
    "node": "1066:42699",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "你们因为幼儿阶段和本地周末活动建立了联系。",
            "You connected through the toddler stage and local weekend activities."
          ]
        ],
        "note": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "Maya",
            "Maya"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "嗨！你们通常去哪个公园？",
            "Hi! Which park do you usually visit?"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "你",
            "You"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "河边的那个。我们大部分周六都会去。",
            "The riverside one. We go most Saturdays."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "Maya",
            "Maya"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "我们也是！也许会在那里碰到你。",
            "Us too! Maybe we'll see you there."
          ]
        ]
      },
      {
        "kind": "row",
        "copy": [
          [
            "稍后见个面",
            "Meet sometime"
          ]
        ],
        "target": "communityMeeting"
      },
      {
        "kind": "row",
        "copy": [
          [
            "翻译辅助",
            "Translation help"
          ]
        ],
        "target": "communityTranslation"
      },
      {
        "kind": "row",
        "copy": [
          [
            "写消息或发送语音",
            "Write or send voice"
          ]
        ],
        "target": "communityTyping"
      }
    ]
  },
  {
    "key": "communityTranslation",
    "title": [
      "翻译辅助",
      "Translation help"
    ],
    "node": "1066:43087",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "Maya",
            "Maya"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "Hola, ¿qué parque suelen visitar?",
            "Hola, ¿qué parque suelen visitar?"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "翻译：嗨，你们通常去哪个公园？",
            "Translation: Hi, which park do you usually visit?"
          ]
        ],
        "note": true
      },
      {
        "kind": "row",
        "copy": [
          [
            "查看原文",
            "View original"
          ]
        ],
        "target": "communityChat"
      },
      {
        "kind": "field",
        "copy": [
          [
            "用自己的语言回复",
            "Reply in your own language"
          ],
          [
            "我们一般去河边的公园。",
            "We usually go to the riverside park."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "Nuri 可以在发送前帮你翻译。",
            "Nuri can help translate before you send."
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "翻译成西班牙语",
            "Translate to Spanish"
          ]
        ],
        "target": "communityTyping"
      },
      {
        "kind": "action",
        "copy": [
          [
            "语音回复",
            "Voice reply"
          ]
        ],
        "target": "communityVoice"
      }
    ]
  },
  {
    "key": "communityMeeting",
    "title": [
      "稍后见个面？",
      "Meet sometime?"
    ],
    "node": "1066:43425",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "给 Maya 一句轻松的邀请，不需要现在决定日期、地点或计划。",
            "Send Maya a casual invitation. No need to decide a date, place or plan now."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "不着急。如果你哪天想在公园见面，我会很开心。",
            "No rush. If you ever feel like meeting at the park, I'd be happy to."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "不会分享位置信息。你们也可以继续在线聊天。",
            "No location information will be shared. You can keep chatting online."
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "发送邀请",
            "Send invitation"
          ]
        ],
        "target": "communityChat"
      },
      {
        "kind": "action",
        "copy": [
          [
            "稍后再说",
            "Maybe later"
          ]
        ],
        "target": "communityChat"
      }
    ]
  },
  {
    "key": "communitySafety",
    "title": [
      "对话设置",
      "Conversation settings"
    ],
    "node": "1066:44205",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "你可以决定如何继续。",
            "You decide how to continue."
          ]
        ]
      },
      {
        "kind": "row",
        "copy": [
          [
            "举报",
            "Report"
          ],
          [
            "有让你不舒服的内容？Maya 不会收到通知。",
            "Something uncomfortable? Maya will not be notified."
          ]
        ],
        "target": "communityReport"
      },
      {
        "kind": "row",
        "copy": [
          [
            "屏蔽",
            "Block"
          ],
          [
            "停止所有消息，彼此不再可见。",
            "Stop all messages and hide from each other."
          ]
        ],
        "target": "communityBlock"
      },
      {
        "kind": "row",
        "copy": [
          [
            "断开联系",
            "Disconnect"
          ],
          [
            "结束这段对话，仍可向其他家长展示资料。",
            "End this conversation while keeping your profile visible to other parents."
          ]
        ],
        "target": "communityDisconnect"
      },
      {
        "kind": "row",
        "copy": [
          [
            "隐藏我的资料",
            "Hide my profile"
          ],
          [
            "不再出现在新的匹配推荐中。",
            "Stop appearing in new match recommendations."
          ]
        ],
        "target": "communityPreferences"
      },
      {
        "kind": "action",
        "copy": [
          [
            "返回对话",
            "Back to conversation"
          ]
        ],
        "target": "communityChat"
      }
    ]
  },
  {
    "key": "communityPreferences",
    "title": [
      "社区聊天设置",
      "Community chat settings"
    ],
    "node": "1066:44581",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "翻译辅助",
            "Translation help"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "西班牙语 ⇄ 英语",
            "Spanish ⇄ English"
          ]
        ],
        "note": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "Nuri 破冰建议",
            "Nuri icebreakers"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "提供开始聊天的方式",
            "Ways to start a conversation"
          ]
        ],
        "note": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "语音消息",
            "Voice messages"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "允许聊天中使用语音",
            "Allow voice in chats"
          ]
        ],
        "note": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "消息通知",
            "Message notifications"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "仅新消息",
            "New messages only"
          ]
        ],
        "note": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "隐藏我的资料",
            "Hide my profile"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "不再出现在新的匹配推荐中",
            "Stop appearing in new matches"
          ]
        ],
        "note": true
      },
      {
        "kind": "row",
        "copy": [
          [
            "屏蔽的家长",
            "Blocked parents"
          ]
        ],
        "target": "communityBlocked"
      },
      {
        "kind": "text",
        "copy": [
          [
            "你可以控制其他家长能看到的信息。",
            "You control what other parents can see."
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "保存设置",
            "Save settings"
          ]
        ],
        "target": "communityInbox"
      }
    ]
  },
  {
    "key": "communityBlocked",
    "title": [
      "屏蔽的家长",
      "Blocked parents"
    ],
    "node": "1066:45032",
    "blocks": [
      {
        "kind": "row",
        "copy": [
          [
            "已屏蔽的家长",
            "Blocked parents"
          ],
          [
            "消息已停止，彼此不可见。",
            "Messages stopped. You are hidden from each other."
          ]
        ],
        "target": "communityUnblock"
      }
    ]
  },
  {
    "key": "communityUnblock",
    "title": [
      "解除屏蔽？",
      "Unblock?"
    ],
    "node": "1066:45325",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "解除后，该家长可能再次与你联系。",
            "This parent may contact you again after unblocking."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "解除屏蔽",
            "Unblock"
          ]
        ],
        "target": "communityPreferences"
      },
      {
        "kind": "action",
        "copy": [
          [
            "保持屏蔽",
            "Keep blocked"
          ]
        ],
        "target": "communityBlocked"
      }
    ]
  },
  {
    "key": "communityReport",
    "title": [
      "举报这段对话",
      "Report this conversation"
    ],
    "node": "1066:45616",
    "blocks": [
      {
        "kind": "choices",
        "copy": [
          [
            "举报原因",
            "Reason"
          ],
          [
            "不适当内容",
            "Inappropriate content"
          ],
          [
            "骚扰",
            "Harassment"
          ],
          [
            "垃圾信息",
            "Spam"
          ],
          [
            "其他",
            "Other"
          ]
        ]
      },
      {
        "kind": "field",
        "copy": [
          [
            "补充说明（可选）",
            "More details (optional)"
          ],
          [
            "告诉我们发生了什么",
            "Tell us what happened"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "对方不会收到举报通知。",
            "The other person will not be notified."
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "提交举报",
            "Submit report"
          ]
        ],
        "target": "communityReported"
      },
      {
        "kind": "action",
        "copy": [
          [
            "取消",
            "Cancel"
          ]
        ],
        "target": "communitySafety"
      }
    ]
  },
  {
    "key": "communityReported",
    "title": [
      "举报已提交",
      "Report submitted"
    ],
    "node": "1066:45983",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "谢谢你告诉我们。你也可以选择屏蔽对方。",
            "Thank you for telling us. You can also block this person."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "返回社区",
            "Back to Community"
          ]
        ],
        "target": "community"
      },
      {
        "kind": "action",
        "copy": [
          [
            "屏蔽对方",
            "Block this person"
          ]
        ],
        "target": "communityBlock"
      }
    ]
  },
  {
    "key": "communityBlock",
    "title": [
      "屏蔽这位家长？",
      "Block this parent?"
    ],
    "node": "1066:46274",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "会停止所有消息，并让你们彼此不可见。",
            "All messages stop and you become hidden from each other."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "确认屏蔽",
            "Confirm block"
          ]
        ],
        "target": "communityInbox"
      },
      {
        "kind": "action",
        "copy": [
          [
            "取消",
            "Cancel"
          ]
        ],
        "target": "communitySafety"
      }
    ]
  },
  {
    "key": "communityDisconnect",
    "title": [
      "断开这段联系？",
      "Disconnect?"
    ],
    "node": "1066:46565",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "会结束这段对话。你的资料仍可向其他家长展示。",
            "This conversation will end. Your profile stays visible to other parents."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "断开联系",
            "Disconnect"
          ]
        ],
        "target": "communityInbox"
      },
      {
        "kind": "action",
        "copy": [
          [
            "取消",
            "Cancel"
          ]
        ],
        "target": "communitySafety"
      }
    ]
  },
  {
    "key": "communityTyping",
    "title": [
      "给 Maya 发消息",
      "Message Maya"
    ],
    "node": "1066:46856",
    "blocks": [
      {
        "kind": "field",
        "copy": [
          [
            "消息",
            "Message"
          ],
          [
            "我们一般周六早上去公园。",
            "We usually go to the park on Saturday mornings."
          ]
        ]
      },
      {
        "kind": "row",
        "copy": [
          [
            "继续使用语音",
            "Continue with voice"
          ]
        ],
        "target": "communityVoice"
      },
      {
        "kind": "action",
        "copy": [
          [
            "发送消息",
            "Send message"
          ]
        ],
        "target": "communityChat"
      },
      {
        "kind": "action",
        "copy": [
          [
            "返回对话",
            "Back to conversation"
          ]
        ],
        "target": "communityChat"
      }
    ]
  },
  {
    "key": "communityVoice",
    "title": [
      "发送语音",
      "Send voice"
    ],
    "node": "1066:47173",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "00:12",
            "00:12"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "慢慢说，录音只会在确认后发送。",
            "Take your time. Recording is sent only after confirmation."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "完成录音",
            "Finish recording"
          ]
        ],
        "target": "communityTyping"
      },
      {
        "kind": "action",
        "copy": [
          [
            "取消录音",
            "Cancel recording"
          ]
        ],
        "target": "communityChat"
      }
    ]
  },
  {
    "key": "communityChatSent",
    "title": [
      "Maya",
      "Maya"
    ],
    "node": "1144:28369",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "Maya",
            "Maya"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "我们也是！也许会在那里碰到你。",
            "Us too! Maybe we'll see you there."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "你",
            "You"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "我们一般周六早上去公园。",
            "We usually go to the park on Saturday mornings."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "Maya",
            "Maya"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "我们也是！有机会一起走走。",
            "Us too! Let's take a walk sometime."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "稍后见个面",
            "Meet sometime"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "翻译辅助",
            "Translation help"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "写消息或发送语音",
            "Write or send voice"
          ]
        ]
      }
    ]
  },
  {
    "key": "notifications",
    "title": [
      "推送中心",
      "Notification center"
    ],
    "node": "1064:5091",
    "blocks": [
      {
        "kind": "row",
        "copy": [
          [
            "Nuri 想问问宝宝最近的睡眠",
            "Nuri would like to ask about your baby's sleep"
          ],
          [
            "今天 · 关怀提醒",
            "Today · Caring reminder"
          ]
        ],
        "target": "notificationDetail"
      },
      {
        "kind": "row",
        "copy": [
          [
            "今天的社交推荐已准备好",
            "Today's social picks are ready"
          ],
          [
            "今天 · Facebook · Threads",
            "Today · Facebook · Threads"
          ]
        ],
        "target": "socialDetail"
      },
      {
        "kind": "row",
        "copy": [
          [
            "有一个适合你的 YouTube 视频",
            "A YouTube video picked for you"
          ],
          [
            "今天 · 视频精选",
            "Today · Video picks"
          ]
        ],
        "target": "videoDetail"
      }
    ]
  },
  {
    "key": "notificationsEmpty",
    "title": [
      "还没有新消息",
      "No new messages"
    ],
    "node": "1066:23778",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "Nuri 的关怀与精选内容，会在这里和你见面。",
            "Nuri's care and selected content will appear here."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "回到首页",
            "Go home"
          ]
        ],
        "target": "home"
      },
      {
        "kind": "action",
        "copy": [
          [
            "管理通知",
            "Manage notifications"
          ]
        ],
        "target": "notificationSettings"
      }
    ]
  },
  {
    "key": "notificationDetail",
    "title": [
      "Nuri 的关怀",
      "A note from Nuri"
    ],
    "node": "1066:24069",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "上次我们聊到宝宝的睡眠。最近有没有新的变化？",
            "Last time we talked about your baby's sleep. Has anything changed recently?"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "继续之前的对话，Nuri 会记得上下文。",
            "Continue the earlier conversation with its context."
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "回复 Nuri",
            "Reply to Nuri"
          ]
        ],
        "target": "chat"
      }
    ]
  },
  {
    "key": "voiceReview",
    "title": [
      "确认语音内容",
      "Review voice input"
    ],
    "node": "1066:22277",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "语音已转成文字，你可以修改后发送。",
            "Your voice is now text. Edit it before sending."
          ]
        ],
        "note": true
      },
      {
        "kind": "field",
        "copy": [
          [
            "你的内容",
            "Your content"
          ],
          [
            "宝宝最近入睡有点困难，晚上容易醒。",
            "My baby has trouble falling asleep and wakes easily at night."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "发送给 Nuri",
            "Send to Nuri"
          ]
        ],
        "target": "chat"
      },
      {
        "kind": "action",
        "copy": [
          [
            "继续语音输入",
            "Continue voice input"
          ]
        ],
        "target": "voice"
      }
    ]
  },
  {
    "key": "childDetail",
    "title": [
      "宝宝的资料",
      "Child profile"
    ],
    "node": "1066:26979",
    "blocks": [
      {
        "kind": "row",
        "copy": [
          [
            "昵称",
            "Nickname"
          ],
          [
            "宝宝",
            "Baby"
          ]
        ],
        "target": "childEdit"
      },
      {
        "kind": "row",
        "copy": [
          [
            "出生日期",
            "Date of birth"
          ],
          [
            "查看与编辑",
            "View and edit"
          ]
        ],
        "target": "childEdit"
      },
      {
        "kind": "row",
        "copy": [
          [
            "过敏信息与备注",
            "Allergies & notes"
          ]
        ],
        "target": "childEdit"
      },
      {
        "kind": "action",
        "copy": [
          [
            "编辑资料",
            "Edit profile"
          ]
        ],
        "target": "childEdit"
      },
      {
        "kind": "action",
        "copy": [
          [
            "删除孩子资料",
            "Delete child profile"
          ]
        ],
        "target": "childDelete"
      }
    ]
  },
  {
    "key": "savedDetail",
    "title": [
      "已保存的内容",
      "Saved content"
    ],
    "node": "1066:28955",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "睡前的小小仪式",
            "A little bedtime ritual"
          ]
        ],
        "heading": true
      },
      {
        "kind": "text",
        "copy": [
          [
            "用简单、熟悉的顺序，陪孩子逐渐安静下来。",
            "A simple, familiar sequence can help your child settle down."
          ]
        ]
      },
      {
        "kind": "row",
        "copy": [
          [
            "放入收藏分类",
            "Put in a collection"
          ]
        ],
        "target": "collectionChoose"
      },
      {
        "kind": "action",
        "copy": [
          [
            "和 Nuri 聊聊",
            "Talk with Nuri"
          ]
        ],
        "target": "chat"
      },
      {
        "kind": "action",
        "copy": [
          [
            "取消收藏",
            "Remove from saved"
          ]
        ],
        "target": "favorites"
      }
    ]
  },
  {
    "key": "collectionChoose",
    "title": [
      "选择收藏分类",
      "Choose a collection"
    ],
    "node": "1066:29926",
    "blocks": [
      {
        "kind": "row",
        "copy": [
          [
            "睡眠与作息",
            "Sleep & routines"
          ]
        ],
        "target": "saved"
      },
      {
        "kind": "row",
        "copy": [
          [
            "情绪与沟通",
            "Emotions & communication"
          ]
        ],
        "target": "saved"
      },
      {
        "kind": "row",
        "copy": [
          [
            "新建分类",
            "New collection"
          ]
        ],
        "target": "collectionCreate"
      },
      {
        "kind": "action",
        "copy": [
          [
            "完成",
            "Done"
          ]
        ],
        "target": "saved"
      }
    ]
  },
  {
    "key": "aiWithdraw",
    "title": [
      "暂时停用 AI 功能？",
      "Pause AI features?"
    ],
    "node": "1066:31216",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "个人资料与已有非 AI 记录仍可使用。之后可以重新选择许可。",
            "Your profile and non-AI records remain available. You can choose permission again later."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "确认撤回",
            "Confirm withdrawal"
          ]
        ],
        "target": "profile"
      },
      {
        "kind": "action",
        "copy": [
          [
            "继续使用 AI",
            "Keep using AI"
          ]
        ],
        "target": "profile"
      }
    ]
  },
  {
    "key": "cleared",
    "title": [
      "云端数据已清除",
      "Cloud data cleared"
    ],
    "node": "1066:32477",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "你可以重新设置资料，或退出登录。",
            "You can set up your profile again, or sign out."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "重新设置",
            "Set up again"
          ]
        ],
        "target": "onboarding"
      },
      {
        "kind": "action",
        "copy": [
          [
            "退出登录",
            "Sign out"
          ]
        ],
        "target": "logout"
      }
    ]
  },
  {
    "key": "deleted",
    "title": [
      "账号已删除",
      "Account deleted"
    ],
    "node": "1066:33081",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "你的账号已删除。谢谢你曾让 Nuri 陪你走过这段日常。",
            "Your account has been deleted. Thank you for sharing these days with Nuri."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "返回欢迎页",
            "Back to welcome"
          ]
        ],
        "target": "welcome"
      }
    ]
  },
  {
    "key": "logout",
    "title": [
      "退出登录？",
      "Sign out?"
    ],
    "node": "1066:33353",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "你可以随时重新登录，继续自己的对话。",
            "Sign in again anytime to continue your conversations."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "退出登录",
            "Sign out"
          ]
        ],
        "target": "welcome"
      },
      {
        "kind": "action",
        "copy": [
          [
            "取消",
            "Cancel"
          ]
        ],
        "target": "profile"
      }
    ]
  },
  {
    "key": "saved",
    "title": [
      "已保存",
      "Saved"
    ],
    "node": "1066:33641",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "修改已保存。",
            "Changes saved."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "完成",
            "Done"
          ]
        ],
        "target": "profile"
      }
    ]
  },
  {
    "key": "attachments",
    "title": [
      "添加内容",
      "Add content"
    ],
    "node": "1066:21252",
    "blocks": [
      {
        "kind": "row",
        "copy": [
          [
            "拍照",
            "Take a photo"
          ]
        ],
        "target": "cameraPermission"
      },
      {
        "kind": "row",
        "copy": [
          [
            "从照片中选择",
            "Choose from photos"
          ]
        ],
        "target": "imagePreview"
      },
      {
        "kind": "action",
        "copy": [
          [
            "取消",
            "Cancel"
          ]
        ],
        "target": "chat"
      }
    ]
  },
  {
    "key": "voicePermission",
    "title": [
      "使用麦克风",
      "Use microphone"
    ],
    "node": "1066:21567",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "允许麦克风后，你可以直接对 Nuri 说话。",
            "Allow microphone access to speak directly to Nuri."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "只有你主动录制的音频才用于语音输入。",
            "Only audio you actively record is used for voice input."
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "继续使用语音",
            "Continue with voice"
          ]
        ],
        "target": "voice"
      },
      {
        "kind": "action",
        "copy": [
          [
            "改用文字",
            "Use text instead"
          ]
        ],
        "target": "chat"
      }
    ]
  },
  {
    "key": "voice",
    "title": [
      "正在聆听",
      "Listening"
    ],
    "node": "1066:21865",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "00:12",
            "00:12"
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "慢慢说，Nuri 在听。",
            "Take your time. Nuri is listening."
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "完成录音",
            "Finish recording"
          ]
        ],
        "target": "voiceReview"
      },
      {
        "kind": "action",
        "copy": [
          [
            "取消录音",
            "Cancel recording"
          ]
        ],
        "target": "chat"
      }
    ]
  },
  {
    "key": "cameraPermission",
    "title": [
      "拍照给 Nuri 看",
      "Show Nuri a photo"
    ],
    "node": "1066:22582",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "允许相机后，可以拍下你想聊的内容。",
            "Allow camera access to photograph what you would like to discuss."
          ]
        ]
      },
      {
        "kind": "text",
        "copy": [
          [
            "发送前，你可以预览或移除照片。",
            "Preview or remove the photo before sending."
          ]
        ],
        "note": true
      },
      {
        "kind": "action",
        "copy": [
          [
            "继续拍照",
            "Continue to camera"
          ]
        ],
        "target": "imagePreview"
      },
      {
        "kind": "action",
        "copy": [
          [
            "从照片中选择",
            "Choose from photos"
          ]
        ],
        "target": "imagePreview"
      }
    ]
  },
  {
    "key": "imagePreview",
    "title": [
      "确认照片",
      "Review photo"
    ],
    "node": "1066:22880",
    "blocks": [
      {
        "kind": "text",
        "copy": [
          [
            "添加一句说明，让 Nuri 更了解你想问什么。",
            "Add a note so Nuri understands your question."
          ]
        ]
      },
      {
        "kind": "field",
        "copy": [
          [
            "想和 Nuri 聊什么？",
            "What would you like to discuss?"
          ],
          [
            "想聊聊宝宝最近的情况…",
            "I'd like to talk about my baby…"
          ]
        ]
      },
      {
        "kind": "action",
        "copy": [
          [
            "发送照片",
            "Send photo"
          ]
        ],
        "target": "chat"
      },
      {
        "kind": "action",
        "copy": [
          [
            "重新选择",
            "Choose again"
          ]
        ],
        "target": "attachments"
      }
    ]
  }
];
