# What this is 
**Learn the Playlist** is a platform in which u can upload an entire playlist(with over 100 vids) along with some docs or pdfs and the ai teaches u like how the playlist does.

This is completely **free to use** with no limits (obv until nvidia decides to add some) and all ur data is store locally as chunks so that the responses are **Blazing Fast**.

This saves time and u dont have to watch a full playlist to understand a few concepts. 
or u can just learn the entire playlist thru here.


# Setting up 
1 . Go to https://build.nvidia.com/ and login.

2 . Navigate to the "Explore" tab and create a API key 

3 . Clone this repo and 

```
cd learn-the-playlist
npm install
npm start
```    
4 . Enter that API key in the popup in ur first run and u r good to go.

**NOTE** - This is still under development . Feel free to Report bugs or Suggest a feature by Starting a [new discussion](https://github.com/Kishalll/learn-the-playlist/discussions)!

### Dev Notes:
#### TO DO -

- [x] shows no captions found in all vids
- [x] nvidia api fetch error
- [x] file upload rate limited while sending to nvidia api
- [x] make app identify 3 types of pdf(searchable,scaned,empty)
- [x] the sources i hv deleted r showing up as sources
- [x] if i upload a same vid or playlist twices it shd not index the same  vid twice

- [x] when i clear sources chat gets cleared too
- [x] ai not mentioning the files uploaded as sources
- [x] api key dialoug box comes briefly on startup- chk api key in the bg
- [x] file remove from knowledge base
- [ ] improve ai's explaination 
- [ ] make all alerts and conformations sent by app not browsers
- [ ] when i ask about a vid , it says bout it but ig it includes unnessary vids as source
- [ ] does not display all sources propery in chat
- [x] add cancel button in playlist processing
- [x] button to retry vids that were not processed
- [x] conformation msg before clearing
- [x] check api valdity b4 starting
- [x] improve settings menu w back button , custom instructions , 
- [ ] add playlist history and store reccent playlist links w heading
- [ ] copy ai's responce link it w the extractor extension

## kill old process - window command

```
taskkill /F /IM node.exe
```
