import asyncio, json, base64, time, sys, uuid, urllib.request
from playwright.async_api import async_playwright
# Five signed-in browsers (passenger, carer, staff, crew, supervisor) walk a whole journey.
# Usage: node tests/e2e/server.mjs &   then   python3 tests/e2e/run.py tests/e2e
SP=sys.argv[1] if len(sys.argv)>1 else "tests/e2e"; BASE="http://localhost:8787"
USERS={}   # email -> {sub,name,groups,password,confirmed}
def mkuser(email,name,group,pw="SmoothDemo2026"): USERS[email]={"sub":"sub-"+uuid.uuid4().hex[:8],"name":name,"groups":[group],"password":pw,"confirmed":True}; return USERS[email]["sub"]
def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")
def tokens(u,email):
    c={"sub":u["sub"],"email":email,"name":u["name"],"cognito:groups":u["groups"],"exp":int(time.time())+3600}
    t=b64({"alg":"none"})+"."+b64(c)+".sig"
    return {"IdToken":t,"AccessToken":t,"RefreshToken":"rt-"+email,"ExpiresIn":3600}
def post(path,data): urllib.request.urlopen(urllib.request.Request(BASE+path,data=json.dumps(data).encode(),method="POST")).read()
async def cognito(route):
    req=route.request; target=req.headers.get("x-amz-target","").split(".")[-1]; b=json.loads(req.post_data or "{}")
    def ok(d): return route.fulfill(status=200,content_type="application/x-amz-json-1.1",body=json.dumps(d))
    def err(code,msg=""): return route.fulfill(status=400,content_type="application/x-amz-json-1.1",body=json.dumps({"__type":code,"message":msg}))
    if target=="SignUp":
        e=b["Username"]
        if e in USERS: return await err("UsernameExistsException")
        attrs={a["Name"]:a["Value"] for a in b["UserAttributes"]}
        if len(b["Password"])<8: return await err("InvalidPasswordException")
        USERS[e]={"sub":"sub-"+uuid.uuid4().hex[:8],"name":attrs.get("name",""),"groups":[],"password":b["Password"],"confirmed":False,"role":attrs.get("custom:role")}
        return await ok({"UserConfirmed":False,"UserSub":USERS[e]["sub"]})
    if target=="ConfirmSignUp":
        u=USERS.get(b["Username"])
        if not u or b["ConfirmationCode"]!="123456": return await err("CodeMismatchException")
        u["confirmed"]=True; u["groups"]=["carer" if u.get("role")=="carer" else "passenger"]   # what the post-confirmation trigger does
        return await ok({})
    if target=="InitiateAuth":
        p=b["AuthParameters"]
        if b["AuthFlow"]=="USER_PASSWORD_AUTH":
            u=USERS.get(p["USERNAME"])
            if not u or u["password"]!=p["PASSWORD"]: return await err("NotAuthorizedException")
            if not u["confirmed"]: return await err("UserNotConfirmedException")
            return await ok({"AuthenticationResult":tokens(u,p["USERNAME"])})
        e=p["REFRESH_TOKEN"][3:]; u=USERS.get(e)
        if not u: return await err("NotAuthorizedException")
        t=tokens(u,e); del t["RefreshToken"]; return await ok({"AuthenticationResult":t})
    if target in ("ResendConfirmationCode","RevokeToken","ForgotPassword"): return await ok({})
    if target=="DeleteUser":
        for k,v in list(USERS.items()):
            if v["sub"]==json.loads(base64.urlsafe_b64decode(b["AccessToken"].split(".")[1]+"=="))["sub"]: del USERS[k]
        return await ok({})
    return await err("InvalidParameterException",target)

async def main():
    subs={k:mkuser(*v) for k,v in {"p":("mrs.chan@example.com","Mrs Chan","passenger"),"c":("mei@example.com","Mei","carer"),"s":("staff@example.com","Alex Wong","staff"),"w":("crew@example.com","Daniel Yip","crew"),"v":("supervisor@example.com","Priya Shah","supervisor")}.items()}
    post("/__seed",{"passenger":{"sub":subs["p"],"name":"Mrs Chan"},"carer":{"sub":subs["c"],"name":"Mei"},"staff":[{"sub":subs["s"],"name":"Alex Wong"}],"crew":{"sub":subs["w"],"name":"Daniel Yip"},"supervisor":{"sub":subs["v"],"name":"Priya Shah"}})
    async with async_playwright() as pw:
        b=await pw.chromium.launch(); errs=[]
        async def phone(name):
            ctx=await b.new_context(viewport={"width":390,"height":844},device_scale_factor=2)
            await ctx.route("https://cognito-idp.test.amazonaws.com/**",cognito)
            pg=await ctx.new_page(); pg.on("pageerror",lambda e:errs.append(name+": "+str(e)))
            pg.on("console",lambda m: m.type=="error" and "fonts" not in m.text and "Failed to load resource" not in m.text and errs.append(name+" console: "+m.text))
            await pg.goto(BASE+"/"); await pg.wait_for_timeout(300); return pg
        shot=lambda pg,n: pg.screenshot(path=f"{SP}/{n}.png")
        txt=lambda pg: pg.inner_text("#app")
        async def until(pg,needle,secs=8):
            for _ in range(secs*4):
                if needle in await txt(pg): return True
                await pg.wait_for_timeout(250)
            raise AssertionError(f"timed out waiting for {needle!r}")

        # 1) A brand-new passenger signs up
        ana=await phone("ana"); await shot(ana,"01-welcome")
        await ana.click('[data-act=go][data-arg=signup]')
        await ana.fill("#fName","Ana"); await ana.fill("#fEmail","ana@test.dev"); await ana.fill("#fPass","Travel2026x")
        assert await ana.is_disabled('[data-act=signup]'); await ana.click('[data-act=ack]'); await shot(ana,"02-signup")
        await ana.click('[data-act=signup]'); await until(ana,"Check your email")
        await ana.fill("#fCode","000000"); await ana.click('[data-act=verify]'); await until(ana,"isn't right")
        await ana.fill("#fCode","123456"); await ana.click('[data-act=verify]'); await until(ana,"Your trip, step by step"); await shot(ana,"03-home")
        # Access Passport with AI
        await ana.click('.tabs [data-arg=passport]')
        await ana.fill("#passText","My name is Mrs Ana Lee (81), phone 9876 5432. I have Parkinson's. I can't manage stairs, I bring my own folding wheelchair, I'm hard of hearing and I'm flying alone.")
        await ana.click('[data-act=passNext]'); t=await txt(ana)
        assert "Lee" not in t.split("What will be sent")[1] and "9876" not in t and "Parkinson" not in t.split("What will be sent")[1], "redaction preview"
        assert await ana.is_disabled('[data-act=passSubmit][data-arg=ai]')
        await ana.click('[data-act=passConsent]'); await shot(ana,"04-consent")
        await ana.click('[data-act=passSubmit][data-arg=ai]'); await until(ana,"Waiting for a staff check"); await shot(ana,"05-passport")
        assert "Condition names were left out" in await txt(ana)
        # 2) Staff check it
        staff=await phone("staff"); await staff.click('[data-act=demoLogin][data-arg="staff@example.com"]'); await until(staff,"Where are you working?")
        await staff.click('.tabs [data-arg=checks]'); await until(staff,"Ana")
        assert "9876" not in await txt(staff)
        await staff.click('[data-act=toggleCode][data-arg$=":3"]'); await shot(staff,"06-staff-check")
        await staff.click('[data-act=verify]'); await until(ana,"Checked by Alex Wong")
        assert "MAAS" not in await txt(ana)
        # 3) Ana books, AI drafts the brief, she edits and approves
        await ana.click('.tabs [data-arg=trip]'); await ana.click('[data-act=book]'); await until(ana,"What the crew will be told")
        await until(ana,"Needs your OK"); assert "Will need help in an evacuation." in await txt(ana)
        await ana.click('[data-act=briefEdit]'); await ana.fill("#briefEdit","Please write things down for me."); await ana.click('[data-act=briefSave]')
        await until(ana,"evacuation line was added back"); await ana.click('[data-act=briefApprove]'); await until(ana,"✓ Approved"); await shot(ana,"07-plan")
        # 4) Ana invites her son, who signs up as a carer
        await ana.click('.tabs [data-arg=privacy]'); await ana.click('[data-act=shareCode]'); await until(ana,"Give this code")
        code=(await ana.inner_text('.card.soft p[style*="mono"]')).strip(); assert len(code)==6; await shot(ana,"08-privacy")
        ben=await phone("ben"); await ben.click('[data-act=go][data-arg=signup]'); await ben.click('[data-act=pickRole][data-arg=carer]')
        await ben.fill("#fName","Ben"); await ben.fill("#fEmail","ben@test.dev"); await ben.fill("#fPass","Helper2026x"); await ben.click('[data-act=ack]'); await ben.click('[data-act=signup]')
        await until(ben,"Check your email"); await ben.fill("#fCode","123456"); await ben.click('[data-act=verify]'); await until(ben,"not following anyone")
        await ben.click('.tabs [data-arg=link]'); await ben.fill("#codeIn",code.lower()); await ben.click('[data-act=linkCode]'); await until(ben,"Booked · CX 255")
        assert "WCHS" not in await txt(ben)
        await until(ana,"Ben"); 
        # 5) Travel day, live handovers seen by the carer
        await ana.click('.tabs [data-arg=trip]'); await ana.click('[data-act=startTravel]'); await until(ana,"STEP 1 OF 6")
        await ana.click('[data-act=help]'); await staff.click('.tabs [data-arg=post]'); await until(staff,"is asking where their help is"); await shot(staff,"09-staff-post")
        await staff.click('[data-act=ackHelp]'); await until(ana,"Alex Wong is coming")
        for pst in ["checkin","security","gate"]:
            await staff.click(f'[data-act=setPost][data-arg={pst}]'); await until(staff,"confirm handover")
            await staff.click('[data-act=handover]'); await until(staff,"Nobody at")
        await until(ben,"Now: On board",10); await until(ben,"has checked in"); await shot(ben,"10-carer")
        # 6) Crew
        crew=await phone("crew"); await crew.click('[data-act=demoLogin][data-arg="crew@example.com"]'); await until(crew,"Please write things down")
        await until(ana,"In-Flight Coach"); await ana.click('[data-act=help]'); await until(crew,"Discreet help request",10); await shot(crew,"11-crew")
        await crew.click('[data-act=ackHelp]'); await until(ana,"Daniel Yip is coming")
        await crew.click('[data-act=handover]'); await until(ben,"Arrival · Heathrow",10)
        # 7) Supervisor: delay re-plan + open data
        sup=await phone("sup"); await sup.click('[data-act=demoLogin][data-arg="supervisor@example.com"]'); await until(sup,"Live handovers")
        await sup.click('[data-act=delay]'); await until(sup,"Approve the new plan"); await until(ana,"A duty manager must approve")
        await sup.click('[data-act=approveDelay]'); await until(ben,"New plan approved",10); await until(sup,"Real HKIA open data"); await shot(sup,"12-supervisor")
        # 8) Arrival team finishes; Carer Mode can be paused
        await staff.click('[data-act=setPost][data-arg=arrival]'); await until(staff,"confirm handover"); await staff.click('[data-act=handover]')
        await until(staff,"confirm handover"); await staff.click('[data-act=handover]'); await until(ana,"You made it")
        await until(ben,"Journey complete",10); await shot(ana,"13-done")
        await ana.click('.tabs [data-arg=privacy]'); await ana.click('[data-act=carerPause]'); await until(ben,"paused sharing",10)
        # 9) Ask: AI answer with source, safety question to a person
        await ana.click('.tabs [data-arg=ask]'); await ana.click('[data-act=ask][data-arg="Can I bring my folding wheelchair?"]'); await until(ana,"confidence 93%")
        await ana.fill("#askin","Can I bring a lithium battery?"); await ana.press("#askin","Enter"); await until(ana,"sent to a person, not the AI"); await shot(ana,"14-ask")
        # 10) Access log, export, delete account
        await ana.click('.tabs [data-arg=privacy]'); t=await txt(ana); assert "Alex Wong" in t and "Daniel Yip" in t, "access log"
        await ana.click('[data-act=exportOpen]'); ex=await ana.inner_text("#exportPre"); assert "9876" not in ex and "Parkinson" not in ex and "Lee" not in ex
        await ana.click('[data-act=sheet]'); await shot(ana,"15-account"); await ana.click('[data-act=askDelete]'); await ana.click('[data-act=deleteAll]'); await until(ana,"Create an account")
        await until(ben,"not following anyone",10)
        # 11) Stay signed in across reloads
        await staff.reload(); await until(staff,"Where are you working?")
        prompts=open(SP+"/prompts.log").read()
        print("PII in AI prompts:",[w for w in ["Lee","9876","Parkinson","81)","Ana"] if w in prompts])
        print("ERRORS:",errs); await b.close()
        print("E2E PASSED")
asyncio.run(main())
