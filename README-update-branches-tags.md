## For BRANCH

### Get all branches and tags of all remote
```bash
git fetch --all --tags
```

### Dump all branches of each remote to file
```
git branch -r --list 'origin/*' | sed 's#^ *origin/##' > origin_branches.txt
git branch -r --list 'base/*' | sed 's#^ *base/##' > base_branches.txt
```

### Check different branches of 2 remote
```
comm -23 <(sort origin_branches.txt) <(sort base_branches.txt) > origin-base_branches.txt
```
```
comm -23 <(sort base_branches.txt) <(sort origin_branches.txt) > base-origin_branches.txt
```

### Delete branches in origin remote but not in base remote
*Open origin-base_branches.txt file and remove all branch don't delete*

```
cat origin-base_branches.txt | xargs -r git push origin --delete
```

### Create branches in base remote but not in origin remote then push to origin remote
```
for branch in $(cat base-origin_branches.txt); do
    git checkout -b $branch base/$branch
    git push origin $branch
done
```

### Verify branch
```
git branch -r --list 'origin/*' | sed 's#^ *origin/##' > origin_branches.txt
git branch -r --list 'base/*' | sed 's#^ *base/##' > base_branches.txt
```

## For TAG
### Create tags in base remote but not in origin remote then push to origin remote
```
git ls-remote --tags base | grep -v '\^{}$' > base_tags.txt
git ls-remote --tags origin | grep -v '\^{}$' > origin_tags.txt
sed 's#^.*refs/tags/##' base_tags.txt > base_tags_clean.txt
sed 's#^.*refs/tags/##' origin_tags.txt > origin_tags_clean.txt

comm -23 <(sort base_tags_clean.txt) <(sort origin_tags_clean.txt) | xargs -r git push origin
```